import websocket from '@fastify/websocket';
import { closeBus, ensureTopics, startConsumer, waitForBus } from '../../shared/bus.js';
import type { SeatHeldPayload, SeatReleasedPayload, SeatSoldPayload } from '../../shared/events.js';
import { log } from '../../shared/log.js';
import { businessEvents } from '../../shared/metrics.js';
import { bootstrap, createServer } from '../../shared/server.js';

/**
 * realtime — fan-out do estado ao vivo por WebSocket.
 *
 * Existe como servico proprio por perfil de escala: conexoes longas com consumo
 * de memoria linear no numero de espectadores. Isolar isso e o que garante que
 * uma sala cheia de gente so olhando o mapa nao consome recursos do checkout —
 * bulkhead na pratica.
 *
 * Estado deliberadamente em memoria. Se o processo reiniciar, os clientes
 * reconectam e recarregam o mapa pelo catalog. Nada aqui e fonte da verdade.
 */

/**
 * Contrato minimo do socket. Evita depender dos tipos do `ws`, que sao um
 * detalhe de implementacao do @fastify/websocket e nao do nosso dominio.
 */
interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, listener: () => void): void;
}

interface Client {
  socket: SocketLike;
  eventId: string;
}

const clients = new Set<Client>();

function broadcast(eventId: string, message: unknown): void {
  const data = JSON.stringify(message);
  let sent = 0;
  for (const client of clients) {
    if (client.eventId !== eventId && client.eventId !== '*') continue;
    // readyState 1 = OPEN
    if (client.socket.readyState !== 1) continue;
    try {
      client.socket.send(data);
      sent++;
    } catch {
      clients.delete(client);
    }
  }
  if (sent > 0) businessEvents.inc({ event: 'realtime_broadcast' }, sent);
}

bootstrap(async () => {
  await waitForBus();
  await ensureTopics();

  let consumer: Awaited<ReturnType<typeof startConsumer>> | undefined;

  return createServer({
    async ready() {
      consumer = await startConsumer({
        groupId: `realtime-${process.env.HOSTNAME ?? Math.random().toString(36).slice(2)}`,
        async onEvent(event) {
          if (event.type === 'SeatHeld') {
            const p = event.payload as unknown as SeatHeldPayload;
            broadcast(p.eventId, { type: 'seat', eventId: p.eventId, seatId: p.seatId, status: 'HELD' });
          } else if (event.type === 'SeatSold') {
            const p = event.payload as unknown as SeatSoldPayload;
            broadcast(p.eventId, { type: 'seat', eventId: p.eventId, seatId: p.seatId, status: 'SOLD' });
          } else if (event.type === 'SeatReleased') {
            const p = event.payload as unknown as SeatReleasedPayload;
            broadcast(p.eventId, {
              type: 'seat',
              eventId: p.eventId,
              seatId: p.seatId,
              status: 'AVAILABLE',
              reason: p.reason,
            });
          }
        },
      });
      log.info('fan-out em tempo real ativo');
    },
    async shutdown() {
      for (const c of clients) {
        try {
          c.socket.close();
        } catch {
          /* ignorado */
        }
      }
      clients.clear();
      if (consumer) await consumer.disconnect();
      await closeBus();
    },
    async routes(app) {
      await app.register(websocket);

      app.get('/ws', { websocket: true }, (socket, req) => {
        const { eventId } = req.query as { eventId?: string };
        const client: Client = { socket: socket as unknown as SocketLike, eventId: eventId ?? '*' };
        clients.add(client);
        businessEvents.inc({ event: 'realtime_connect' });

        try {
          client.socket.send(JSON.stringify({ type: 'hello', eventId: client.eventId }));
        } catch {
          /* ignorado */
        }

        client.socket.on('close', () => clients.delete(client));
        client.socket.on('error', () => clients.delete(client));
      });

      app.get('/connections', async () => ({ connections: clients.size }));
    },
  });
});
