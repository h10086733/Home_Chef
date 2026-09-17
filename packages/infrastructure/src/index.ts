import { randomUUID } from 'node:crypto';
import type { PaymentCallback } from '@home-chef/contracts';

export interface PaymentProvider {
  createPayment(input: { amountFen: number; idempotencyKey: string; description: string }): Promise<{ provider: string; providerRef: string; status: 'PROCESSING' | 'SUCCEEDED' }>;
  parseCallback(payload: unknown): PaymentCallback;
}

/** Deterministic local provider. It never represents a production payment channel. */
export class SandboxPaymentProvider implements PaymentProvider {
  async createPayment(input: { amountFen: number; idempotencyKey: string; description: string }): Promise<{ provider: string; providerRef: string; status: 'PROCESSING' | 'SUCCEEDED' }> {
    if (!Number.isSafeInteger(input.amountFen) || input.amountFen <= 0) throw new Error('payment amount must be a positive integer');
    return { provider: 'sandbox', providerRef: `sandbox_${randomUUID()}`, status: 'SUCCEEDED' };
  }
  parseCallback(payload: unknown): PaymentCallback {
    if (!payload || typeof payload !== 'object') throw new Error('invalid payment callback');
    const value = payload as Record<string, unknown>;
    if (typeof value.providerRef !== 'string' || typeof value.idempotencyKey !== 'string' || typeof value.amountFen !== 'number') throw new Error('invalid payment callback fields');
    const status = value.status === 'FAILED' ? 'FAILED' : value.status === 'SUCCEEDED' ? 'SUCCEEDED' : null;
    if (!status) throw new Error('invalid payment callback status');
    return { provider: 'sandbox', providerRef: value.providerRef, idempotencyKey: value.idempotencyKey, status, amountFen: value.amountFen, rawEvent: payload };
  }
}

export * from './outbox';
export * from './outbox-runner';
export * from './prisma-outbox';

export * from './logging';
