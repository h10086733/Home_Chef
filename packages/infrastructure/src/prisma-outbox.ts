import { PrismaClient } from '@prisma/client';
import type { OutboxStore } from './outbox-runner';
import type { PendingOutboxEvent } from './outbox';

export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly db: PrismaClient) {}

  async takePending(limit: number): Promise<PendingOutboxEvent[]> {
    const rows = await this.db.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { occurredAt: 'asc' }, take: limit });
    return rows.map((row) => ({ id: row.id, eventType: row.eventType, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payload, occurredAt: row.occurredAt.toISOString(), attempts: row.attempts }));
  }

  async markPublished(id: string, publishedAt: Date): Promise<void> {
    await this.db.outboxEvent.update({ where: { id }, data: { publishedAt, attempts: { increment: 1 } } });
  }
}
