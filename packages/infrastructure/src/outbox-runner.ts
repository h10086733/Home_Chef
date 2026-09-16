import { publishOutboxBatch, type EventPublisher, type PendingOutboxEvent, type OutboxMarker } from './outbox';

export interface OutboxStore {
  takePending(limit: number): Promise<PendingOutboxEvent[]>;
}

export interface OutboxRunResult {
  selected: number;
  published: number;
  failed: number;
}

/** One idempotent worker tick. A failed event remains unpublished so the next
 * tick can retry it; consumers must deduplicate by event id. */
export async function runOutboxTick(store: OutboxStore, publisher: EventPublisher, limit = 100): Promise<OutboxRunResult> {
  const events = await store.takePending(limit);
  let published = 0;
  let failed = 0;
  for (const event of events) {
    try {
      published += await publishOutboxBatch([event], publisher, 1);
      const marker = store as OutboxStore & Partial<OutboxMarker>;
      if (marker.markPublished) await marker.markPublished(event.id, new Date());
    } catch {
      failed += 1;
    }
  }
  return { selected: events.length, published, failed };
}
