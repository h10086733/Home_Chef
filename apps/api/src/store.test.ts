import { MvpStore } from './store';

const store = new MvpStore();
const quote = store.createQuote({ customerId: 'u1', chefId: 'chef-owner', totalFen: 10000 });
const order = store.payQuote(quote.id, 'DEPOSIT', 'test-idempotency');
const invited = store.inviteCandidates(order.id, [
  { chefId: 'chef-a', distanceM: 800 },
  { chefId: 'chef-b', distanceM: 900 },
  { chefId: 'chef-c', distanceM: 1200 },
]);
if (invited.length !== 3) throw new Error('expected three candidates');
const claimed = store.claimCandidate(order.id, 'chef-b');
if (claimed.chefId !== 'chef-b' || claimed.contractStatus !== 'ACCEPTED') throw new Error('candidate claim failed');
let failed = false;
try { store.claimCandidate(order.id, 'chef-a'); } catch { failed = true; }
if (!failed) throw new Error('second candidate should not claim an accepted order');
