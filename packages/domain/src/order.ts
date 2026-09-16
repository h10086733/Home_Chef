import { ContractStatus, depositAmount, transitionContract } from './index';

export type PaymentChoice = 'DEPOSIT' | 'FULL_PAYMENT';

export interface CreateOrderInput {
  totalFen: number;
  paymentChoice: PaymentChoice;
  depositRate?: number;
}

export interface OrderAmounts {
  totalFen: number;
  depositFen: number;
  balanceFen: number;
}

export function calculateOrderAmounts(input: CreateOrderInput): OrderAmounts {
  if (!Number.isSafeInteger(input.totalFen) || input.totalFen <= 0) throw new Error('totalFen must be a positive integer');
  const depositFen = depositAmount(input.totalFen, input.depositRate ?? 0.3);
  return {
    totalFen: input.totalFen,
    depositFen,
    balanceFen: input.paymentChoice === 'FULL_PAYMENT' ? 0 : input.totalFen - depositFen,
  };
}

export function markPaymentSucceeded(status: ContractStatus, paymentChoice: PaymentChoice): ContractStatus {
  if (status !== 'PENDING_PAYMENT') throw new Error('order is not awaiting initial payment');
  // Full or deposit payment both lead to waiting for chef acceptance.
  void paymentChoice;
  return transitionContract(status, 'PENDING_ACCEPTANCE');
}
