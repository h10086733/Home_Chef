import { runOutboxTick, type OutboxStore } from './outbox-runner';
import type { PendingOutboxEvent } from './outbox';

const events: PendingOutboxEvent[] = [
  { id: 'evt-ok', eventType: 'QuoteCreated', aggregateType: 'Quote', aggregateId: 'q1', payload: {}, occurredAt: new Date().toISOString(), attempts: 0 },
  { id: 'evt-fail', eventType: 'OrderPaymentSucceeded', aggregateType: 'Order', aggregateId: 'o1', payload: {}, occurredAt: new Date().toISOString(), attempts: 0 },
];
const store: OutboxStore = { takePending: async () => events.filter((event) => !event.publishedAt) };
(async () => {
  const result = await runOutboxTick(store, { publish: async (event) => { if (event.id === 'evt-fail') throw new Error('temporary'); } });
  if (result.selected !== 2 || result.published !== 1 || result.failed !== 1) throw new Error('outbox tick result mismatch');
  if (!events[0].publishedAt || events[1].publishedAt) throw new Error('outbox retry state mismatch');
})();
