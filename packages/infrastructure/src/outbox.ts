export interface PendingOutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: string;
  publishedAt?: string;
  attempts: number;
}

export interface EventPublisher { publish(event: PendingOutboxEvent): Promise<void>; }

export interface OutboxMarker { markPublished(id: string, publishedAt: Date): Promise<void>; }

/** Publishes each event at-least-once. The repository must mark an event as
 * published only after publish resolves; consumers must be idempotent. */
export async function publishOutboxBatch(events: PendingOutboxEvent[], publisher: EventPublisher, limit = 100): Promise<number> {
  let published = 0;
  for (const event of events.filter((item) => !item.publishedAt).slice(0, limit)) {
    event.attempts += 1;
    await publisher.publish(event);
    event.publishedAt = new Date().toISOString();
    published += 1;
  }
  return published;
}
