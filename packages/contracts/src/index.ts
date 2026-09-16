export interface PaymentCreatedEvent {
  eventId: string;
  eventType: 'PaymentCreated';
  orderId: string;
  paymentRequestId: string;
  amountFen: number;
  kind: 'DEPOSIT' | 'FULL_PAYMENT' | 'BALANCE' | 'ADDITIONAL';
  idempotencyKey: string;
  occurredAt: string;
}

export interface PaymentCallback {
  provider: string;
  providerRef: string;
  idempotencyKey: string;
  status: 'SUCCEEDED' | 'FAILED';
  amountFen: number;
  rawEvent: unknown;
}

export interface ApiErrorBody { error: { code: string; message: string; traceId?: string } }
