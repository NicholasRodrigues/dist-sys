import { randomUUID } from 'node:crypto';
import { config } from '../../shared/config.js';
import { issueToken } from '../../shared/jwt.js';
import { log } from '../../shared/log.js';
import { admissionsTotal, queueDepth } from '../../shared/metrics.js';
import { getFlagBool, getFlagInt, redis } from '../../shared/redis.js';

/**
 * Fila virtual — o controle de admissao, e a tese do projeto.
 *
 * O nucleo ACID nao escala junto com o resto do sistema. Em vez de tentar
 * reforca-lo, nos o protegemos: a fila converte um pico irregular impossivel de
 * absorver em uma vazao constante e dimensionavel.
 *
 * O efeito que o teste C3 demonstra e contraintuitivo: admitindo MENOS usuarios
 * por segundo, o sistema conclui MAIS compras — porque para de gastar
 * capacidade em requisicoes que iam falhar de qualquer forma.
 *
 * Estrutura no Redis:
 *   queue:<eventId>     ZSET  score = instante de entrada, membro = token
 *   admitted:<token>    STRING com TTL, gravado quando a vez chega
 *
 * O ZSET da a posicao em O(log n) com ZRANK, que e o que a tela precisa mostrar.
 */

const ADMISSION_TICK_MS = 1000;

export interface QueueTicket {
  queueToken: string;
  position: number;
  ahead: number;
  admitted: boolean;
  admissionToken?: string;
  estimatedWaitSeconds: number;
}

export async function queueEnabled(): Promise<boolean> {
  return getFlagBool('queue_enabled', true);
}

/** Quantas pessoas por segundo entram no nucleo transacional. */
export async function admissionRate(): Promise<number> {
  return getFlagInt('admission_rate', 50);
}

export async function join(eventId: string): Promise<QueueTicket> {
  const queueToken = randomUUID();
  const key = `queue:${eventId}`;
  await redis.zadd(key, Date.now(), queueToken);
  await redis.expire(key, 3600);
  return status(eventId, queueToken);
}

export async function status(eventId: string, queueToken: string): Promise<QueueTicket> {
  const admitted = await redis.get(`admitted:${queueToken}`);
  if (admitted) {
    return {
      queueToken,
      position: 0,
      ahead: 0,
      admitted: true,
      // O token de admissao e um JWT curto com escopo proprio. O checkout so
      // aceita este escopo, entao ninguem pula a fila chamando a API direto.
      admissionToken: issueToken(
        { sub: queueToken, scope: 'checkout', eventId },
        config.admissionTtlSeconds,
      ),
      estimatedWaitSeconds: 0,
    };
  }

  const rank = await redis.zrank(`queue:${eventId}`, queueToken);
  if (rank === null) {
    // Nao esta na fila e nao foi admitido: token expirado ou desconhecido.
    return { queueToken, position: -1, ahead: -1, admitted: false, estimatedWaitSeconds: -1 };
  }

  const rate = await admissionRate();
  return {
    queueToken,
    position: rank + 1,
    ahead: rank,
    admitted: false,
    estimatedWaitSeconds: rate > 0 ? Math.ceil(rank / rate) : -1,
  };
}

/**
 * Libera a proxima leva de admissoes.
 *
 * O lock existe porque varias replicas do `edge` rodam este loop: sem ele, N
 * replicas admitiriam N vezes a taxa configurada, e a fila viraria enfeite.
 */
async function drainOnce(eventId: string): Promise<number> {
  const lockKey = `admission:lock:${eventId}`;
  const lockId = randomUUID();
  const acquired = await redis.set(lockKey, lockId, 'PX', ADMISSION_TICK_MS - 100, 'NX');
  if (!acquired) return 0;

  const rate = await admissionRate();
  if (rate <= 0) return 0;

  const key = `queue:${eventId}`;
  const batch = await redis.zrange(key, 0, rate - 1);
  if (batch.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const token of batch) {
    pipeline.setex(`admitted:${token}`, config.admissionTtlSeconds, '1');
  }
  pipeline.zrem(key, ...batch);
  await pipeline.exec();

  admissionsTotal.inc(batch.length);
  return batch.length;
}

let timer: NodeJS.Timeout | undefined;

export function startAdmissionLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      try {
        if (!(await queueEnabled())) return;
        // Descobre as filas ativas a cada tick: o conjunto de shows em venda
        // muda, e nao ha configuracao estatica para manter em dia.
        const keys = await redis.keys('queue:*');
        for (const key of keys) {
          const eventId = key.slice('queue:'.length);
          const admitted = await drainOnce(eventId);
          const depth = await redis.zcard(key);
          queueDepth.set({ event_id: eventId }, depth);
          if (admitted > 0) {
            log.debug('admissoes liberadas', { eventId, admitted, remaining: depth });
          }
        }
      } catch (err) {
        log.warn('falha no loop de admissao', { error: String(err) });
      }
    })();
  }, ADMISSION_TICK_MS);
  timer.unref();
}

export function stopAdmissionLoop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Esvazia a fila de um evento. Usado entre rodadas de teste de carga. */
export async function reset(eventId: string): Promise<void> {
  await redis.del(`queue:${eventId}`);
  const admittedKeys = await redis.keys('admitted:*');
  if (admittedKeys.length > 0) await redis.del(...admittedKeys);
  queueDepth.set({ event_id: eventId }, 0);
}
