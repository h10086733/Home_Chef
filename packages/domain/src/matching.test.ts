import { recommendChefs } from './matching';

const base = { acceptingOrders: true, certified: true, frozen: false, available: true };

const result = recommendChefs([
  { chefId: 'far', distanceM: 2500, ...base },
  { chefId: 'near', distanceM: 800, ...base },
  { chefId: 'near-2', distanceM: 900, ...base },
  { chefId: 'near-3', distanceM: 950, ...base },
  { chefId: 'disabled', distanceM: 100, ...base, acceptingOrders: false },
], { urgent: true });

if (result.map((item) => item.chefId).join(',') !== 'near,near-2,near-3') throw new Error('urgent matching should prioritize 1km candidates and cap at 3');
