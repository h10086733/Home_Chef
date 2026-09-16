import { publishOutboxBatch, type PendingOutboxEvent } from './outbox';

const events: PendingOutboxEvent[] = [{ id: 'evt-1', eventType: 'QuoteCreated', aggregateType: 'Quote', aggregateId: 'q1', payload: {}, occurredAt: new Date().toISOString(), attempts: 0 }];
let count = 0;
(async () => {
  const published = await publishOutboxBatch(events, { publish: async () => { count += 1; } });
  if (published !== 1 || count !== 1 || !events[0].publishedAt || events[0].attempts !== 1) throw new Error('outbox publish failed');
})();
