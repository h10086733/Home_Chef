import { randomUUID } from 'node:crypto';
import { PrismaClient, type ContractStatus, type PaymentSummaryStatus } from '@prisma/client';

export interface QuoteInput { customerId: string; chefId: string; packageId?: string; totalFen: number; depositFen: number; balanceFen: number; expiresAt: Date; ruleVersion: string; }
export interface OrderView { id: string; quoteId: string; customerId: string; chefId: string; totalFen: number; depositFen: number; balanceFen: number; receivedFen: number; refundedFen: number; contractStatus: ContractStatus; paymentStatus: PaymentSummaryStatus; }

export class PrismaOrderRepository {
  constructor(private readonly db: PrismaClient) {}

  async createQuote(input: QuoteInput) {
    return this.db.quote.create({ data: { customerId: input.customerId, chefId: input.chefId, packageId: input.packageId, totalFen: input.totalFen, depositFen: input.depositFen, balanceFen: input.balanceFen, expiresAt: input.expiresAt, ruleVersion: input.ruleVersion } });
  }

  async createPaidOrder(input: { quoteId: string; addressId: string; paymentChoice: 'DEPOSIT' | 'FULL_PAYMENT'; idempotencyKey: string; providerRef: string }) {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.paymentRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { order: true } });
      if (existing?.order) return existing.order;
      const quote = await tx.quote.findUnique({ where: { id: input.quoteId } });
      if (!quote) throw new Error('QUOTE_NOT_FOUND');
      if (quote.status !== 'ACTIVE' || quote.expiresAt <= new Date()) throw new Error('QUOTE_NOT_ACTIVE');
      const amountFen = input.paymentChoice === 'FULL_PAYMENT' ? quote.totalFen : quote.depositFen;
      const order = await tx.order.create({ data: { quoteId: quote.id, customerId: quote.customerId, addressId: input.addressId, totalFen: quote.totalFen, depositFen: quote.depositFen, balanceFen: input.paymentChoice === 'FULL_PAYMENT' ? 0 : quote.balanceFen, receivedFen: amountFen, contractStatus: 'PENDING_ACCEPTANCE', paymentStatus: input.paymentChoice === 'FULL_PAYMENT' ? 'FULLY_PAID' : 'DEPOSIT_PAID', ruleSnapshot: { ruleVersion: quote.ruleVersion, paymentChoice: input.paymentChoice } } });
      await tx.paymentRequest.create({ data: { orderId: order.id, kind: input.paymentChoice, amountFen, status: 'SUCCEEDED', idempotencyKey: input.idempotencyKey, provider: 'sandbox', providerRef: input.providerRef } });
      await tx.quote.update({ where: { id: quote.id }, data: { status: 'PAID' } });
      await tx.outboxEvent.create({ data: { eventType: 'OrderPaymentSucceeded', aggregateType: 'Order', aggregateId: order.id, payload: { paymentChoice: input.paymentChoice, amountFen } } });
      return order;
    });
  }

  async acceptOrder(orderId: string, chefId: string) {
    return this.db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.contractStatus !== 'PENDING_ACCEPTANCE') throw new Error('ORDER_NOT_ACCEPTABLE');
      if (order.acceptedChefId && order.acceptedChefId !== chefId) throw new Error('CHEF_NOT_INVITED');
      const updated = await tx.order.update({ where: { id: order.id }, data: { contractStatus: 'ACCEPTED', acceptedChefId: chefId } });
      await tx.outboxEvent.create({ data: { eventType: 'ChefAcceptedOrder', aggregateType: 'Order', aggregateId: order.id, payload: { chefId } } });
      return updated;
    });
  }

  async cancelOrder(orderId: string) {
    return this.db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || (order.contractStatus !== 'PENDING_ACCEPTANCE' && order.contractStatus !== 'ACCEPTED')) throw new Error('ORDER_NOT_CANCELLABLE');
      const updated = await tx.order.update({ where: { id: order.id }, data: { contractStatus: 'CANCELLED', refundedFen: order.receivedFen, receivedFen: 0, paymentStatus: 'FULLY_REFUNDED' } });
      await tx.paymentRequest.updateMany({ where: { orderId: order.id, status: 'SUCCEEDED' }, data: { status: 'REFUNDED' } });
      await tx.outboxEvent.create({ data: { eventType: 'OrderCancelledAndRefunded', aggregateType: 'Order', aggregateId: order.id, payload: { refundedFen: order.receivedFen } } });
      return updated;
    });
  }

  async inviteMatchedChefs(orderId: string, candidates: Array<{ chefId: string; distanceM: number }>, options: { urgent: boolean; ruleVersion: string }) {
    if (candidates.length > 3) throw new Error('MATCH_CANDIDATE_LIMIT');
    return this.db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.contractStatus !== 'PENDING_ACCEPTANCE') throw new Error('ORDER_NOT_MATCHABLE');
      const rows = [];
      for (const candidate of candidates) {
        rows.push(await tx.chefOrder.upsert({
          where: { orderId_chefId: { orderId, chefId: candidate.chefId } },
          update: { status: 'INVITED', distanceM: candidate.distanceM, urgent: options.urgent, ruleVersion: options.ruleVersion, invitedAt: new Date() },
          create: { orderId, chefId: candidate.chefId, distanceM: candidate.distanceM, urgent: options.urgent, ruleVersion: options.ruleVersion },
        }));
      }
      await tx.outboxEvent.create({ data: { eventType: 'ChefsMatched', aggregateType: 'Order', aggregateId: orderId, payload: { candidateCount: rows.length, urgent: options.urgent, ruleVersion: options.ruleVersion } } });
      return rows;
    });
  }

  async claimMatchedOrder(orderId: string, chefId: string) {
    return this.db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order || order.contractStatus !== 'PENDING_ACCEPTANCE') throw new Error('ORDER_NOT_CLAIMABLE');
      const candidate = await tx.chefOrder.findUnique({ where: { orderId_chefId: { orderId, chefId } } });
      if (!candidate || candidate.status !== 'INVITED') throw new Error('CHEF_NOT_INVITED');
      const claimed = await tx.chefOrder.updateMany({ where: { orderId, status: 'INVITED' }, data: { status: 'DECLINED' } });
      if (claimed.count < 1) throw new Error('ORDER_ALREADY_CLAIMED');
      await tx.chefOrder.update({ where: { id: candidate.id }, data: { status: 'ACCEPTED' } });
      const updated = await tx.order.update({ where: { id: orderId }, data: { contractStatus: 'ACCEPTED', acceptedChefId: chefId } });
      await tx.outboxEvent.create({ data: { eventType: 'ChefAcceptedOrder', aggregateType: 'Order', aggregateId: orderId, payload: { chefId, matched: true } } });
      return updated;
    }, { isolationLevel: 'Serializable' });
  }
}
