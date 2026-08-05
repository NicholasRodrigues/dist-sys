import { randomUUID } from 'node:crypto';
import { closeBus, ensureTopics, waitForBus } from '../../shared/bus.js';
import { config } from '../../shared/config.js';
import { query, transaction, waitForDatabase } from '../../shared/db.js';
import { RemoteError, request } from '../../shared/httpClient.js';
import { businessEvents } from '../../shared/metrics.js';
import { enqueue, startOutboxPublisher, stopOutboxPublisher } from '../../shared/outbox.js';
import { bootstrap, createServer } from '../../shared/server.js';

/**
 * payments — dono do dinheiro.
 *
 * Duas ideias sustentam este servico:
 *
 * 1. **Ledger de dupla entrada.** Nao existe coluna de saldo. Cada cobranca
 *    grava dois lancamentos que se anulam, e `SELECT sum(amount_cents) FROM
 *    ledger_entries` tem que dar zero em qualquer instante. Uma consulta de uma
 *    linha detecta qualquer inconsistencia financeira do sistema inteiro.
 *
 * 2. **Anti-corruption layer.** O contrato do PSP nao vaza para dentro. Se o
 *    PSP mudar, muda o adaptador, e `orders` nem fica sabendo.
 */

interface ChargeRow {
  id: string;
  saga_id: string;
  order_id: string;
  user_id: string;
  amount_cents: number;
  status: 'CAPTURED' | 'REFUNDED' | 'FAILED';
  psp_reference: string | null;
  created_at: Date;
}

function serialize(c: ChargeRow) {
  return {
    chargeId: c.id,
    sagaId: c.saga_id,
    orderId: c.order_id,
    amountCents: c.amount_cents,
    status: c.status,
    pspReference: c.psp_reference,
  };
}

/** Adaptador do PSP: o unico ponto do sistema que conhece o formato externo. */
const psp = {
  async charge(input: { key: string; amountCents: number; reference: string }) {
    const res = await request<{ pspChargeId: string; status: string }>(
      `${config.pspUrl}/pix/charges`,
      {
        method: 'POST',
        target: 'psp',
        body: {
          amountCents: input.amountCents,
          idempotencyKey: input.key,
          reference: input.reference,
        },
        // Sem retry automatico: uma cobranca com timeout precisa de
        // reconciliacao explicita, nao de outra tentativa as cegas.
        retries: 0,
        timeoutMs: 4000,
      },
    );
    return { reference: res.pspChargeId, approved: res.status === 'APPROVED' };
  },

  /** Consulta por chave: o que torna a reconciliacao possivel. */
  async findByKey(key: string) {
    try {
      const res = await request<{ pspChargeId: string; status: string }>(
        `${config.pspUrl}/pix/charges/by-key/${encodeURIComponent(key)}`,
        { target: 'psp', retries: 1, timeoutMs: 3000 },
      );
      return { reference: res.pspChargeId, approved: res.status === 'APPROVED' };
    } catch (err) {
      if (err instanceof RemoteError && err.status === 404) return undefined;
      throw err;
    }
  },

  async refund(reference: string) {
    await request(`${config.pspUrl}/pix/charges/${encodeURIComponent(reference)}/refund`, {
      method: 'POST',
      target: 'psp',
      retries: 2,
    });
  },
};

bootstrap(async () => {
  await waitForDatabase();
  await waitForBus();
  await ensureTopics();

  return createServer({
    async ready() {
      startOutboxPublisher();
    },
    async shutdown() {
      stopOutboxPublisher();
      await closeBus();
    },
    routes(app) {
      /**
       * Cobra. Idempotente por `idempotencyKey`.
       *
       * A ordem importa: consultamos o PSP por chave ANTES de cobrar de novo,
       * porque uma tentativa anterior pode ter sido aprovada com a resposta
       * perdida. Sem esse passo, uma retentativa cobraria duas vezes.
       */
      app.post('/charges', async (req, reply) => {
        const body = req.body as {
          sagaId?: string;
          orderId?: string;
          userId?: string;
          amountCents?: number;
          idempotencyKey?: string;
        };

        if (!body?.sagaId || !body.orderId || !body.userId || !body.amountCents) {
          return reply
            .code(400)
            .send({ error: 'sagaId, orderId, userId e amountCents sao obrigatorios' });
        }
        // Extraidos para constantes: o narrowing do TypeScript nao sobrevive
        // ao closure da transacao, e sem isso o compilador nao consegue provar
        // que os campos ja foram validados acima.
        const { sagaId, orderId, userId, amountCents } = body as {
          sagaId: string;
          orderId: string;
          userId: string;
          amountCents: number;
        };
        const key = body.idempotencyKey ?? sagaId;

        const existing = await query<ChargeRow>(
          `SELECT * FROM charges WHERE idempotency_key = $1 OR saga_id = $2`,
          [key, sagaId],
        );
        if (existing.length > 0) {
          return reply.code(200).send({ ...serialize(existing[0]), replayed: true });
        }

        // Uma cobranca aprovada em tentativa anterior cuja resposta se perdeu.
        let pspResult = await psp.findByKey(key);
        if (!pspResult) {
          pspResult = await psp.charge({
            key,
            amountCents: amountCents,
            reference: orderId,
          });
        }

        if (!pspResult.approved) {
          return reply.code(402).send({ error: 'pagamento recusado', sagaId: sagaId });
        }

        try {
          const charge = await transaction(async (client) => {
            const id = randomUUID();
            const rows = await query<ChargeRow>(
              `INSERT INTO charges
                 (id, saga_id, order_id, user_id, amount_cents, status, psp_reference, idempotency_key)
               VALUES ($1, $2, $3, $4, $5, 'CAPTURED', $6, $7)
               RETURNING *`,
              [
                id,
                sagaId,
                orderId,
                userId,
                amountCents,
                pspResult.reference,
                key,
              ],
              client,
            );

            // Dupla entrada: o cliente paga, a plataforma recebe. Soma zero.
            await client.query(
              `INSERT INTO ledger_entries (charge_id, saga_id, account, amount_cents, entry_type)
               VALUES ($1, $2, $3, $4, 'CAPTURE'), ($1, $2, $5, $6, 'CAPTURE')`,
              [
                id,
                sagaId,
                `customer:${userId}`,
                -amountCents,
                'platform:revenue',
                amountCents,
              ],
            );

            await enqueue(client, 'PaymentCaptured', orderId!, {
              sagaId: sagaId,
              orderId: orderId,
              amountCents: amountCents,
            });

            return rows[0];
          });

          businessEvents.inc({ event: 'payment_captured' });
          return reply.code(201).send(serialize(charge));
        } catch (err) {
          // Corrida entre duas requisicoes com a mesma chave: a perdedora le a
          // linha da vencedora em vez de cobrar de novo.
          if (isUniqueViolation(err)) {
            const rows = await query<ChargeRow>(
              `SELECT * FROM charges WHERE idempotency_key = $1 OR saga_id = $2`,
              [key, sagaId],
            );
            if (rows.length > 0) return reply.code(200).send({ ...serialize(rows[0]), replayed: true });
          }
          throw err;
        }
      });

      /** Consulta por saga: usada pela reconciliacao do orquestrador. */
      app.get('/charges/:sagaId', async (req, reply) => {
        const { sagaId } = req.params as { sagaId: string };
        const rows = await query<ChargeRow>(`SELECT * FROM charges WHERE saga_id = $1`, [sagaId]);
        if (rows.length === 0) return reply.code(404).send({ error: 'cobranca inexistente' });
        return serialize(rows[0]);
      });

      /** Compensacao: estorna. Idempotente. */
      app.post('/charges/:sagaId/refund', async (req, reply) => {
        const { sagaId } = req.params as { sagaId: string };

        const rows = await query<ChargeRow>(`SELECT * FROM charges WHERE saga_id = $1`, [sagaId]);
        const charge = rows[0];
        if (!charge) return reply.code(404).send({ error: 'cobranca inexistente' });
        if (charge.status === 'REFUNDED') return { ...serialize(charge), replayed: true };

        if (charge.psp_reference) await psp.refund(charge.psp_reference);

        const refunded = await transaction(async (client) => {
          const updated = await query<ChargeRow>(
            `UPDATE charges SET status = 'REFUNDED', refunded_at = now() WHERE saga_id = $1 RETURNING *`,
            [sagaId],
            client,
          );
          // O estorno nao apaga os lancamentos originais: acrescenta os
          // inversos. O ledger e append-only, e o historico continua auditavel.
          await client.query(
            `INSERT INTO ledger_entries (charge_id, saga_id, account, amount_cents, entry_type)
             VALUES ($1, $2, $3, $4, 'REFUND'), ($1, $2, $5, $6, 'REFUND')`,
            [
              charge.id,
              sagaId,
              `customer:${charge.user_id}`,
              charge.amount_cents,
              'platform:revenue',
              -charge.amount_cents,
            ],
          );
          await enqueue(client, 'PaymentRefunded', charge.order_id, {
            sagaId,
            orderId: charge.order_id,
            amountCents: charge.amount_cents,
          });
          return updated[0];
        });

        businessEvents.inc({ event: 'payment_refunded' });
        return serialize(refunded);
      });

      /** Saldo derivado do historico, nunca de uma coluna mutavel. */
      app.get('/ledger/balance/:account', async (req) => {
        const { account } = req.params as { account: string };
        const rows = await query<{ balance: number }>(
          `SELECT COALESCE(sum(amount_cents), 0)::bigint AS balance
             FROM ledger_entries WHERE account = $1`,
          [account],
        );
        return { account, balanceCents: Number(rows[0]?.balance ?? 0) };
      });

      /** A verificacao contabil do sistema inteiro, em uma consulta. */
      app.get('/ledger/health', async () => {
        const rows = await query<{ total: number; entries: number }>(
          `SELECT COALESCE(sum(amount_cents), 0)::bigint AS total,
                  count(*)::bigint AS entries
             FROM ledger_entries`,
        );
        const total = Number(rows[0]?.total ?? 0);
        return { balanced: total === 0, sumCents: total, entries: Number(rows[0]?.entries ?? 0) };
      });
    },
  });
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
