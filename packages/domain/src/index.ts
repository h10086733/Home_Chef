export type ContractStatus = 'PENDING_PAYMENT' | 'PENDING_ACCEPTANCE' | 'ACCEPTED' | 'PAYMENT_EXCEPTION' | 'FULFILLED' | 'CLOSED' | 'CANCELLED';

export type PaymentStatus = 'UNPAID' | 'DEPOSIT_PAID' | 'FULLY_PAID' | 'PARTIALLY_REFUNDED' | 'FULLY_REFUNDED';

export class InvalidTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Invalid state transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

const transitions: Record<ContractStatus, readonly ContractStatus[]> = {
  PENDING_PAYMENT: ['PENDING_ACCEPTANCE', 'PAYMENT_EXCEPTION', 'CLOSED'],
  PENDING_ACCEPTANCE: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['FULFILLED', 'CANCELLED'],
  PAYMENT_EXCEPTION: ['CLOSED'],
  FULFILLED: [],
  CLOSED: [],
  CANCELLED: [],
};

export function transitionContract(from: ContractStatus, to: ContractStatus): ContractStatus {
  if (!transitions[from].includes(to)) throw new InvalidTransitionError(from, to);
  return to;
}

export function depositAmount(totalFen: number, rate = 0.3): number {
  if (!Number.isSafeInteger(totalFen) || totalFen < 0) throw new Error('totalFen must be a non-negative integer');
  if (rate <= 0 || rate >= 1) throw new Error('deposit rate must be between 0 and 1');
  return Math.round(totalFen * rate);
}

export * from './order';
export * from './matching';
