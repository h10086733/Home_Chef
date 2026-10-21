import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {MvpService} from '../apps/api/src/support';
import {hashPassword} from '../apps/api/src/security';

assert(process.env.DATABASE_URL?.includes('/home_chef_test'), 'Only isolated test database');
assert.equal(process.env.APP_MODE, 'sandbox', 'Full lifecycle uses sandbox payment to complete the order without WeChat merchant');

const db = new PrismaClient();
let now = new Date();
now.setUTCSeconds(0, 0);
const svc = new MvpService(db, () => now);
const prefix = 'life' + randomUUID().replaceAll('-', '').slice(0, 10);
const password = 'LifecycleTest2026!';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzkAAAAASUVORK5CYII=';
const users: Record<string, any> = {};
after(() => db.$disconnect());

test('full local lifecycle: chef apply, admin review, customer book, accept, fulfill, confirm, review, settle', async () => {
  users.admin = await db.user.create({
    data: {
      username: prefix + '_admin',
      displayName: '全链路审核员',
      roles: ['ADMIN', 'REVIEWER', 'FINANCE', 'FINANCE_MANAGER', 'CUSTOMER_SERVICE'],
      passwordHash: hashPassword(password),
    },
  });
  await db.platformRule.create({
    data: {
      id: prefix + '-rules',
      publishedBy: users.admin.id,
      data: {
        sandbox: true,
        commissionRate: 0.15,
        matchMinutes: 10,
        radiusM: 3000,
        urgentMinMinutes: 30,
        autoConfirmHours: 48,
        settlementTrigger: 'REVIEW_OR_EXPIRE',
        settlementDelayHours: 0,
        couponEnabled: false,
        couponFen: 2000,
        couponMinFen: 20000,
        regions: [{code: prefix, name: '全链路测试片区', active: true}],
      },
    },
  });

  // 1. Chef registers and applies
  const chefLogin = await svc.login({username: prefix + '_chef', password, displayName: '全链路厨师'}, true);
  users.chef = await svc.session(chefLogin.token);
  const health = await svc.upload(users.chef, {base64: png, mime: 'image/png'});
  const pending = await svc.applyChef(users.chef, {
    bio: '全链路测试拿手家常菜',
    cuisines: ['湘菜'],
    regionCode: prefix,
    latitude: 28.194,
    longitude: 112.961,
    healthValidUntil: new Date(now.getTime() + 365 * 86400000).toISOString(),
    healthAssetId: health.id,
    agreement: true,
    coordinateSystem: 'GCJ02',
  });
  assert.equal(pending.status, 'PENDING_REVIEW');
  assert.equal((await svc.chefs({search: '全链路测试拿手家常菜'})).length, 0);

  // 2. Admin reviews to TRIAL
  await svc.auditChef(users.admin, pending.id, {
    status: 'TRIAL',
    reason: '全链路隔离验收通过',
    checks: ['identity', 'health', 'skill', 'conduct'],
  });
  const reviewed = await db.chef.findUniqueOrThrow({where: {id: pending.id}});
  assert.equal(reviewed.status, 'TRIAL');
  assert.equal(reviewed.acceptingOrders, true);

  // 3. Chef publishes package and schedule
  const pkg = await svc.savePackage(users.chef, {
    name: '全链路家常套餐',
    description: '备菜、烹饪、装盘、基础台面归位',
    serviceFen: 19800,
  });
  await svc.saveSchedule(users.chef, {
    startsAt: new Date(now.getTime() + 86400000).toISOString(),
    endsAt: new Date(now.getTime() + 20 * 86400000).toISOString(),
  });
  const discovered = await svc.chefs({search: '全链路家常套餐', latitude: 28.194, longitude: 112.961, regionCode: prefix});
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].id, pending.id);

  // 4. Customer registers, locates (coordinates), saves address, quotes and pays
  const customerLogin = await svc.login({username: prefix + '_customer', password, displayName: '全链路用户'}, true);
  users.customer = await svc.session(customerLogin.token);
  const address = await svc.address(users.customer, {
    label: '测试家',
    regionCode: prefix,
    latitude: 28.194,
    longitude: 112.961,
    coordinateSystem: 'GCJ02',
    fullText: '长沙市岳麓区全链路测试楼 1 单元 101',
  });
  const startsAt = new Date(now.getTime() + 3 * 86400000);
  startsAt.setUTCHours(10, 0, 0, 0);
  const quote = await svc.quote(users.customer, {
    packageId: pkg.id,
    addressId: address.id,
    startsAt: startsAt.toISOString(),
    hours: 2,
    guests: 4,
    children: 0,
    elders: 0,
    allergens: '无已知过敏',
    kitchen: '燃气灶、炒锅可用',
    cuisine: '湘菜',
    ingredientMode: 'CUSTOMER',
    mode: 'SELF',
  });
  assert.equal(quote.totalFen, 19800);
  assert.equal(quote.depositFen, 5940);
  // sandbox：报价后直接沙箱支付成单；business 路径才是 submitQuote → 微信收款
  const paid = await svc.payQuote(users.customer, quote.id, {
    paymentChoice: 'FULL_PAYMENT',
    idempotencyKey: randomUUID(),
  });
  assert.equal(paid.contractStatus, 'PENDING_ACCEPTANCE');
  assert.equal(paid.paymentStatus, 'FULLY_PAID');
  assert.equal(paid.receivedFen, 19800);
  assert.equal(paid.sandbox, true);

  // 5. Chef accepts
  const accepted = await svc.accept(users.chef, paid.id);
  assert.equal(accepted.contractStatus, 'ACCEPTED');
  assert.equal(accepted.acceptedChefId, pending.id);
  assert.equal(accepted.fulfillmentStatus, 'READY');

  // 6. Fulfillment with evidence
  const previous = now;
  now = new Date(startsAt);
  for (const action of ['depart', 'arrive', 'start'] as const) {
    await svc.fulfill(users.chef, paid.id, {action, evidence: '全链路履约记录'});
  }
  const photo = await svc.upload(users.chef, {orderId: paid.id, mime: 'image/png', base64: png});
  await svc.fulfill(users.chef, paid.id, {
    action: 'complete',
    evidence: '成品已交接',
    assetId: photo.id,
    actualIngredientFen: 0,
  });
  let order = await svc.getOrder(users.customer, paid.id);
  assert.equal(order.fulfillmentStatus, 'AWAITING_CONFIRMATION');

  // 7. Customer confirms completion
  await svc.customerAction(users.customer, paid.id, 'confirm-fees', {});
  await svc.customerAction(users.customer, paid.id, 'confirm', {});
  order = await svc.getOrder(users.customer, paid.id);
  assert.equal(order.contractStatus, 'FULFILLED');
  assert.equal(order.fulfillmentStatus, 'COMPLETED');
  assert.equal(order.reviewStatus, 'OPEN');
  assert.equal(order.settlementStatus, 'PENDING');

  // 8. Settlement waits for review under new rules
  await assert.rejects(() => svc.settle(users.admin, paid.id), /评价/);
  await svc.review(users.customer, paid.id, {
    taste: 5,
    service: 5,
    punctuality: 5,
    body: '全链路验收满意',
  });
  const settled = await svc.settle(users.admin, paid.id);
  assert.equal((settled as any).chefFen, 16830);
  assert.equal((settled as any).commissionFen, 2970);
  order = await db.order.findUniqueOrThrow({where: {id: paid.id}});
  assert.equal(order.settlementStatus, 'SETTLED');
  assert.equal(order.reviewStatus, 'REVIEWED');

  // 9. Ops surfaces remain usable
  const dashboard = await svc.dashboard(users.admin);
  assert.ok(dashboard.orders >= 1);
  assert.ok((await svc.opsChefs(users.admin)).some((c: any) => c.id === pending.id));
  assert.ok((await svc.opsUsers(users.admin)).some((u: any) => u.id === users.customer.id));

  now = previous;
  console.log('FULL LIFECYCLE PASS', {
    chefId: pending.id,
    orderId: paid.id,
    receivedFen: paid.receivedFen,
    chefFen: (settled as any).chefFen,
  });
});
