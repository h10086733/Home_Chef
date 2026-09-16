import { calculateOrderAmounts } from './order';

const deposit = calculateOrderAmounts({ totalFen: 130000, paymentChoice: 'DEPOSIT' });
if (deposit.depositFen !== 39000 || deposit.balanceFen !== 91000) throw new Error('30% deposit calculation failed');
const full = calculateOrderAmounts({ totalFen: 130000, paymentChoice: 'FULL_PAYMENT' });
if (full.depositFen !== 39000 || full.balanceFen !== 0) throw new Error('full payment calculation failed');
