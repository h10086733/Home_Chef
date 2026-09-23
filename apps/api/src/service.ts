import {logContext} from '@home-chef/infrastructure';
import { PrismaClient, Prisma, User, Order } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError, ensure, text, integer } from './errors';
import { hashPassword, checkPassword, digest, encrypt, decrypt } from './security';

type Tx = Prisma.TransactionClient;
type Data = Record<string, any>;
const obj = (v: unknown): Data => v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const HOUR = 3600000;
const SAFE_CHEF = { id: true, status: true, healthValidUntil: true, serviceRadiusM: true, acceptingOrders: true, user: { select: { displayName: true } }, packages: { where: { active: true } } } as const;
export class Service {
  constructor(readonly db: PrismaClient, readonly clock: () => Date = () => new Date()) {}
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(async tx => {
      // All commands (including timers) share this lock across processes. The DB
      // exclusion constraint additionally enforces chef time-range exclusivity.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(781406)`;
      return fn(tx);
    }, { timeout: 20000, maxWait: 20000 });
  }
  role(user: User, ...roles: string[]) { ensure(user.roles.some(r => roles.includes(r)), 'FORBIDDEN', '当前账号无权执行此操作', 403); }
  async audit(tx: Tx, actorId: string | null, action: string, id: string, after: Data = {}) {
    await tx.auditEvent.create({ data: { actorId, action, aggregateType: 'MVP', aggregateId: id, after: after as Prisma.InputJsonValue, traceId: typeof logContext.getStore()?.requestId==='string'?String(logContext.getStore()!.requestId):randomUUID() } });
  }
  async event(tx: Tx, name: string, order: Order, recipients: string[] = []) {
    await tx.outboxEvent.create({ data: { eventType: name, aggregateType: 'Order', aggregateId: order.id, payload: { recipients: [...new Set([order.customerId, ...recipients])], body: name, ruleVersion: obj(order.ruleSnapshot).id } } });
  }
  async rules(tx: Tx): Promise<Data> {
    const rule = await tx.platformRule.findFirst({ orderBy: { createdAt: 'desc' } });
    ensure(rule, 'RULES_UNAVAILABLE', '运营尚未发布规则'); return { ...obj(rule.data), id: rule.id };
  }
  async session(token: string): Promise<User> {
    ensure(token, 'UNAUTHORIZED', '请先登录', 401);
    const s = await this.db.appSession.findUnique({ where: { id: digest(token) } });
    ensure(s && s.expiresAt > this.clock(), 'UNAUTHORIZED', '登录已过期', 401);
    const u = await this.db.user.findUnique({ where: { id: s.userId } }); ensure(u, 'UNAUTHORIZED', '账号不存在', 401); return u;
  }
  async login(body: Data, register = false) {
    const username = text(body.username, '账号', 40), password = text(body.password, '密码', 128);
    ensure(/^[a-zA-Z0-9_-]{3,40}$/.test(username), 'INVALID_INPUT', '账号须为3至40位字母、数字、下划线', 400);
    let user = await this.db.user.findUnique({ where: { username } });
    if (register) {
      ensure(password.length >= 10, 'WEAK_PASSWORD', '密码至少10位', 400);
      ensure(!user, 'USERNAME_TAKEN', '账号已存在');
      try{user = await this.db.user.create({ data: { username, passwordHash: hashPassword(password), displayName: text(body.displayName, '昵称', 30), roles: ['USER'] } });}catch(e:any){if(e.code==='P2002')throw new ApiError(409,'USERNAME_TAKEN','账号已存在');throw e;}
    } else ensure(user?.passwordHash && checkPassword(password, user.passwordHash), 'INVALID_CREDENTIALS', '账号或密码不正确', 401);
    const token = randomBytes(32).toString('hex');
    await this.db.appSession.create({ data: { id: digest(token), userId: user!.id, expiresAt: new Date(this.clock().getTime() + 24 * HOUR) } });
    return { token, user: this.publicUser(user!) };
  }
  publicUser(user: User) { return { id: user.id, displayName: user.displayName, roles: user.roles, username: user.username, phoneBound:!!user.phoneVerifiedAt }; }
  async logout(token: string) { await this.db.appSession.deleteMany({ where: { id: digest(token) } }); return { ok: true }; }
  async addresses(user: User) {
    const rows = await this.db.address.findMany({ where: { userId: user.id } });
    return rows.map(a => ({ ...a, encryptedText: undefined, fullText: a.encryptedText ? decrypt(a.encryptedText) : '' }));
  }
  async address(user: User, b: Data) {
    return this.transaction(async tx => {
      const rules = await this.rules(tx), regionCode = text(b.regionCode, '片区');
      ensure(rules.regions.some((r: Data) => r.code === regionCode && r.active), 'REGION_CLOSED', '该片区暂未开放');
      ensure(!b.coordinateSystem || b.coordinateSystem === 'GCJ02', 'INVALID_LOCATION', '地图坐标系必须为 GCJ-02', 400); const lat = Number(b.latitude), lng = Number(b.longitude);
      ensure(Number.isFinite(lat) && Number.isFinite(lng) && lat >= 27.8 && lat <= 28.5 && lng >= 112.5 && lng <= 113.5, 'INVALID_LOCATION', '所选位置不在当前长沙服务范围，请重新地图选址', 400);
      const address = await tx.address.create({ data: { userId: user.id, label: text(b.label, '地址名称', 30), regionCode, latitude: lat, longitude: lng, maskedText: rules.regions.find((r: Data) => r.code === regionCode).name, encryptedText: encrypt(text(b.fullText, '详细地址', 200)) } });
      await this.audit(tx, user.id, 'ADDRESS_CREATED', address.id); return { id: address.id };
    });
  }
  async deleteAddress(user: User, id: string) {
    return this.transaction(async tx => {
      const a = await tx.address.findUnique({ where: { id } }); ensure(a?.userId === user.id, 'NOT_FOUND', '地址不存在', 404);
      ensure(await tx.order.count({ where: { addressId: id } }) === 0, 'ADDRESS_IN_USE', '历史订单关联地址不可删除，可新增地址');
      await tx.address.delete({ where: { id } }); await this.audit(tx, user.id, 'ADDRESS_DELETED', id); return { ok: true };
    });
  }
  async chefs(query: Data = {}) {
    const rows = await this.db.chef.findMany({where:{status:{in:['APPROVED','TRIAL']},acceptingOrders:true,healthValidUntil:{gt:this.clock()}},include:{user:{select:{displayName:true}},packages:{where:{active:true}}}});
    const ratings=await this.db.review.groupBy({by:['chefId'],where:{hidden:false},_avg:{taste:true,service:true,punctuality:true},_count:{_all:true}});
    const search=String(query.search??'').trim().toLocaleLowerCase(),cuisine=String(query.cuisine??'');
    const located=query.latitude!==undefined&&query.longitude!==undefined,lat=Number(query.latitude),lng=Number(query.longitude);
    ensure(!located||(Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180),'INVALID_LOCATION','位置无效',400);
    const sort=String(query.sort??'default');ensure(['default','price_asc','price_desc','distance'].includes(sort),'INVALID_SORT','排序方式无效',400);
    ensure(sort!=='distance'||located,'LOCATION_REQUIRED','请先选择位置',400);
    const rules=await this.rules(this.db),regionCode=String(query.regionCode??'');
    const result=rows.map(c=>{const d=obj(c.data),r=ratings.find(v=>v.chefId===c.id),distanceM=located?this.distance(lat,lng,d.latitude,d.longitude):null;
      return {id:c.id,name:c.user.displayName,status:c.status,healthValidUntil:c.healthValidUntil,serviceRadiusM:rules.radiusM??c.serviceRadiusM,cuisines:d.cuisines??[],bio:d.bio??'',regionCode:d.regionCode,packages:c.packages,rating:r?((r._avg.taste??0)+(r._avg.service??0)+(r._avg.punctuality??0))/3:null,reviewCount:r?._count._all??0,distanceM:Number.isFinite(distanceM)?distanceM:null};
    }).filter(c=>rules.regions.some((r:Data)=>r.active&&r.code===c.regionCode)&&(!regionCode||c.regionCode===regionCode)&&(!cuisine||cuisine==='全部'||c.cuisines.includes(cuisine))&&(!search||[c.name,c.bio,...c.cuisines,...c.packages.map(p=>p.name+' '+p.description)].join(' ').toLocaleLowerCase().includes(search))&&(!located||(c.distanceM!==null&&c.distanceM<=c.serviceRadiusM)));
    const price=(c:typeof result[number])=>c.packages.length?Math.min(...c.packages.map(p=>p.serviceFen)):Number.MAX_SAFE_INTEGER;
    result.sort((x,y)=>sort==='price_asc'?price(x)-price(y):sort==='price_desc'?price(y)-price(x):sort==='distance'?(x.distanceM??Infinity)-(y.distanceM??Infinity):x.id.localeCompare(y.id));
    return result;
  }
  async submitQuote(user:User,id:string) {
    return this.transaction(async tx=>{
      const q=await tx.quote.findUnique({where:{id}});ensure(q?.customerId===user.id,'NOT_FOUND','报价不存在',404);
      const existing=await tx.order.findUnique({where:{quoteId:id}});if(existing)return this.viewOrder(tx,user,existing);
      ensure(q.status==='ACTIVE'&&q.expiresAt>this.clock(),'QUOTE_EXPIRED','报价已过期，请重新报价');
      const d=obj(q.details),rules=await this.rules(tx);ensure(rules.regions.some((r:Data)=>r.code===d.regionCode&&r.active),'REGION_CLOSED','所选地区暂未开放');
      if(d.mode==='SELF')ensure(await this.available(tx,q.chefId,d,q.id),'SCHEDULE_CONFLICT','所选档期不可用');
      const order=await tx.order.create({data:{customerId:user.id,addressId:d.addressId,quoteId:id,totalFen:q.totalFen,depositFen:q.depositFen,balanceFen:q.totalFen,receivedFen:0,contractStatus:'PENDING_PAYMENT',paymentStatus:'UNPAID',ruleSnapshot:d.rules,details:{...d,selectedChefId:q.chefId,paymentDeadline:q.expiresAt.toISOString()}}});
      await tx.quote.update({where:{id},data:{status:'SUBMITTED'}});
      await tx.bookingLock.updateMany({where:{quoteId:id},data:{orderId:order.id}});
      await this.audit(tx,user.id,'ORDER_SUBMITTED',order.id);await this.event(tx,'订单已提交，等待付款；暂未安排服务',order);
      return this.viewOrder(tx,user,order);
    });
  }
  async chefProfile(user: User) { const c = await this.db.chef.findUnique({ where: { userId: user.id }, include: { packages: true, schedules: true } }); return c; }
  async applyChef(user: User, b: Data) {
    return this.transaction(async tx => {
      const existing = await tx.chef.findUnique({ where: { userId: user.id } });
      ensure(!existing || ['PENDING_REVIEW','REJECTED'].includes(existing.status), 'CHEF_ALREADY_ACTIVE', '已入驻厨师请联系运营变更资质');
      ensure(Array.isArray(b.cuisines) && b.cuisines.length > 0 && b.cuisines.every((c: unknown) => typeof c === 'string'), 'INVALID_CUISINES', '请选择菜系', 400);
      const healthValidUntil = new Date(text(b.healthValidUntil, '健康证有效期'));
      ensure(healthValidUntil > this.clock(), 'EXPIRED_HEALTH', '健康证已过期', 400);
      const file = await tx.fileAsset.findUnique({ where: { id: text(b.healthAssetId, '健康证明') } }); ensure(file?.userId === user.id, 'INVALID_EVIDENCE', '请上传本人健康证明', 400);
      ensure(b.agreement === true, 'AGREEMENT_REQUIRED', '请确认入驻协议和服务边界', 400);
      const data = { bio: text(b.bio, '自我介绍', 500), cuisines: b.cuisines, regionCode: text(b.regionCode, '片区'), latitude: Number(b.latitude), longitude: Number(b.longitude), healthAssetId: file.id, agreementAt: this.clock().toISOString() };
      ensure((!b.coordinateSystem || b.coordinateSystem === 'GCJ02') && Number.isFinite(data.latitude) && Number.isFinite(data.longitude) && data.latitude >= 27.8 && data.latitude <= 28.5 && data.longitude >= 112.5 && data.longitude <= 113.5, 'INVALID_LOCATION', '请选择长沙服务范围内的接单出发位置', 400); const rules = await this.rules(tx); ensure(rules.regions.some((r:Data)=>r.active&&r.code===data.regionCode),'REGION_CLOSED','该片区暂未开放');
      const chef = await tx.chef.upsert({ where: { userId: user.id }, create: { userId: user.id, status: 'PENDING_REVIEW', healthValidUntil, data }, update: { status: 'PENDING_REVIEW', healthValidUntil, data } });
      await tx.user.update({ where: { id: user.id }, data: { roles: { set: [...new Set([...user.roles, 'CHEF' as const])] } } });
      await this.audit(tx, user.id, 'CHEF_APPLIED', chef.id); return chef;
    });
  }
  async savePackage(user: User, b: Data) {
    return this.transaction(async tx => {
      const c = await tx.chef.findUnique({ where: { userId: user.id } }); ensure(c && ['APPROVED','TRIAL'].includes(c.status), 'NOT_APPROVED', '审核通过后可维护套餐');
      const row = await tx.servicePackage.create({ data: { chefId: c.id, name: text(b.name, '套餐名称', 60), description: text(b.description, '服务范围', 500), serviceFen: integer(b.serviceFen, '服务价格', 100, 1000000) } });
      await this.audit(tx, user.id, 'PACKAGE_CREATED', row.id); return row;
    });
  }
  async saveSchedule(user: User, b: Data) {
    return this.transaction(async tx => {
      const c = await tx.chef.findUnique({ where: { userId: user.id } }); ensure(c, 'NOT_CHEF', '请先申请厨师');
      const startsAt = new Date(text(b.startsAt, '开始时间')), endsAt = new Date(text(b.endsAt, '结束时间'));
      ensure(startsAt > this.clock() && endsAt > startsAt && endsAt.getTime() - startsAt.getTime() <= 31 * 24 * HOUR, 'INVALID_TIME', '档期时间无效', 400);
      return tx.scheduleSlot.create({ data: { chefId: c.id, startsAt, endsAt } });
    });
  }
  distance(lat1: number, lng1: number, lat2: number, lng2: number) {
    const rad = Math.PI / 180, a = Math.sin((lat2-lat1)*rad/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin((lng2-lng1)*rad/2)**2;
    return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
  }
  async available(tx: Tx, chefId: string, d: Data, quoteId?: string): Promise<boolean> {
    const c = await tx.chef.findUnique({ where: { id: chefId } });
    if (!c || !c.acceptingOrders || !['APPROVED','TRIAL'].includes(c.status) || !c.healthValidUntil || c.healthValidUntil <= new Date(d.endsAt)) return false;
    const live = await this.rules(tx);
    if (!live.regions.some((r: Data) => r.code === d.regionCode && r.active)) return false;
    const cd = obj(c.data);
    if (![cd.latitude,cd.longitude,d.latitude,d.longitude].every(Number.isFinite)) return false;
    if (cd.regionCode !== d.regionCode || (d.cuisine && !cd.cuisines?.includes(d.cuisine))) return false;
    if (this.distance(d.latitude, d.longitude, cd.latitude, cd.longitude) > (d.radiusM ?? c.serviceRadiusM)) return false;
    const startsAt = new Date(new Date(d.startsAt).getTime() - HOUR), endsAt = new Date(new Date(d.endsAt).getTime() + HOUR);
    const slot = await tx.scheduleSlot.findFirst({ where: { chefId, status: 'AVAILABLE', startsAt: { lte: startsAt }, endsAt: { gte: endsAt } } });
    if (!slot) return false;
    return !await tx.bookingLock.findFirst({ where: { chefId, ...(quoteId ? { quoteId: { not: quoteId } } : {}), startsAt: { lt: endsAt }, endsAt: { gt: startsAt }, OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock() } }] } });
  }
  async quote(user: User, b: Data) {
    return this.transaction(async tx => {
      await tx.bookingLock.deleteMany({ where: { expiresAt: { lte: this.clock() } } });
      const rules = await this.rules(tx), pkg = await tx.servicePackage.findUnique({ where: { id: text(b.packageId, '套餐') } });
      ensure(pkg?.active, 'PACKAGE_UNAVAILABLE', '套餐已下架');
      const a = await tx.address.findUnique({ where: { id: text(b.addressId, '地址') } }); ensure(a?.userId === user.id, 'INVALID_ADDRESS', '请选择本人地址', 403);
      ensure(rules.regions.some((r: Data) => r.code === a.regionCode && r.active), 'REGION_CLOSED', '片区暂停服务');
      const startsAt = new Date(text(b.startsAt, '上门时间')), hours = integer(b.hours ?? 2, '服务时长', 1, 8);
      const advance = startsAt.getTime() - this.clock().getTime();
      const urgent = b.urgent === true;
      ensure(Number.isFinite(advance) && advance <= 30 * 24 * HOUR && (urgent ? advance >= rules.urgentMinMinutes * 60000 && advance <= 2 * HOUR : advance >= 24 * HOUR), 'BOOKING_WINDOW', '普通预约提前24小时至30天；急单按已发布最小提前量至2小时', 400);
      ensure(startsAt.getMinutes() % 30 === 0 && startsAt.getSeconds() === 0, 'TIME_GRANULARITY', '上门时间须为整点或半点', 400);
      const endsAt = new Date(startsAt.getTime() + hours * HOUR);
      ensure(['CUSTOMER','CHEF'].includes(b.ingredientMode), 'INVALID_INGREDIENT_MODE', '请选择食材方式', 400);
      const ingredientFen = b.ingredientMode === 'CHEF' ? integer(b.ingredientFen, '采购预算', 100, 100000) : 0;
      const guests = integer(b.guests, '用餐人数', 1, 30);
      const details: Data = { mode: b.mode === 'MATCH' ? 'MATCH' : 'SELF', addressId: a.id, regionCode: a.regionCode, latitude: Number(a.latitude), longitude: Number(a.longitude), maskedAddress: a.maskedText, encryptedAddress: a.encryptedText, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), urgent, guests, children: integer(b.children ?? 0, '儿童人数', 0, guests), elders: integer(b.elders ?? 0, '老人人数', 0, guests), allergens: text(b.allergens, '过敏信息（没有请填无已知过敏）', 200), kitchen: text(b.kitchen, '厨房条件', 200), taste: text(b.taste ?? '家常口味', '口味', 200), ingredientMode: b.ingredientMode, ingredientFen, serviceFen: pkg.serviceFen, cuisine: text(b.cuisine, '菜系', 30), packageName: pkg.name, serviceScope: pkg.description, radiusM: rules.radiusM, couponId: null, discountFen: 0, rules };
      ensure(details.children + details.elders <= guests, 'INVALID_GUESTS', '儿童与老人总数不能超过用餐人数', 400);
      if (b.couponId) {
        const coupon = await tx.coupon.findUnique({ where: { id: text(b.couponId, '优惠券') } });
        ensure(coupon?.userId === user.id && coupon.status === 'AVAILABLE' && coupon.expiresAt > this.clock() && coupon.regionCode === a.regionCode && pkg.serviceFen + ingredientFen >= coupon.minFen, 'COUPON_UNAVAILABLE', '优惠券不可用');
        details.couponId = coupon.id; details.discountFen = Math.min(coupon.amountFen, pkg.serviceFen); details.couponVersion = coupon.ruleVersion;
      }
      const provider=await tx.chef.findUnique({where:{id:pkg.chefId}}),providerData=obj(provider?.data);
      ensure(provider&&providerData.regionCode===a.regionCode&&[providerData.latitude,providerData.longitude].every(Number.isFinite)&&this.distance(details.latitude,details.longitude,providerData.latitude,providerData.longitude)<=details.radiusM,'CHEF_OUT_OF_RANGE','该厨师不服务所选地址，请更换地址或厨师');
      ensure(await this.available(tx, pkg.chefId, details), 'CHEF_UNAVAILABLE', '厨师在所选时间不可预约，请检查档期、服务时长或更换厨师');
      const totalFen = pkg.serviceFen + ingredientFen - details.discountFen, depositFen = Math.round(totalFen * .3);
      const q = await tx.quote.create({ data: { customerId: user.id, chefId: pkg.chefId, packageId: pkg.id, totalFen, depositFen, balanceFen: totalFen - depositFen, ruleVersion: rules.id, expiresAt: new Date(this.clock().getTime() + 30 * 60000), details } });
      if (details.mode === 'SELF') await tx.bookingLock.create({ data: { chefId: pkg.chefId, quoteId: q.id, startsAt: new Date(startsAt.getTime()-HOUR), endsAt: new Date(endsAt.getTime()+HOUR), expiresAt: q.expiresAt } });
      await this.audit(tx, user.id, 'QUOTE_CREATED', q.id, { totalFen, mode: details.mode });
      return { ...q, details: { ...details, encryptedAddress: undefined } };
    });
  }
  async payment(tx: Tx, order: Order, amountFen: number, kind: 'DEPOSIT'|'FULL_PAYMENT'|'BALANCE'|'ADDITIONAL', key: string) {
    ensure(process.env.APP_MODE==='sandbox','PAYMENT_UNAVAILABLE','在线支付尚未开通，订单未扣款',503);
    const request = await tx.paymentRequest.create({ data: { orderId: order.id, amountFen, kind, status: 'SUCCEEDED', idempotencyKey: key, provider: 'sandbox', providerRef: 'sandbox_' + randomUUID() } });
    await tx.ledgerEntry.create({ data: { orderId: order.id, reference: request.id, kind: 'PAYMENT', amountFen } });
    return request;
  }
  async payQuote(user: User, id: string, b: Data) {
    ensure(process.env.APP_MODE==='sandbox','PAYMENT_UNAVAILABLE','在线支付尚未开通，请先提交待支付订单',503);
    const choice = b.paymentChoice; ensure(choice === 'DEPOSIT' || choice === 'FULL_PAYMENT', 'INVALID_PAYMENT_CHOICE', '请选择定金或全款', 400);
    const key = user.id + ':quote:' + text(b.idempotencyKey, '幂等键', 100);
    return this.transaction(async tx => {
      const old = await tx.paymentRequest.findUnique({ where: { idempotencyKey: key }, include: { order: true } });
      if (old) { ensure(old.order.quoteId === id && old.kind === choice, 'IDEMPOTENCY_CONFLICT', '幂等键已用于其他付款'); return this.viewOrder(tx, user, old.order); }
      const q = await tx.quote.findUnique({ where: { id } }); ensure(q?.customerId === user.id, 'NOT_FOUND', '报价不存在', 404);
      ensure(q.status === 'ACTIVE' && q.expiresAt > this.clock(), 'QUOTE_EXPIRED', '报价过期，请重新报价');
      const d = obj(q.details), live = await this.rules(tx);
      ensure(live.regions.some((r: Data) => r.code === d.regionCode && r.active), 'REGION_CLOSED', '片区暂停服务');
      if (d.mode === 'SELF') ensure(await this.available(tx, q.chefId, d, q.id), 'SCHEDULE_CONFLICT', '档期冲突或厨师资质失效');
      if (d.couponId) { const c = await tx.coupon.findUnique({ where: { id: d.couponId } }); ensure(c?.status === 'AVAILABLE' && c.expiresAt > this.clock(), 'COUPON_UNAVAILABLE', '优惠券已被使用或过期'); }
      const amountFen = choice === 'DEPOSIT' ? q.depositFen : q.totalFen;
      const order = await tx.order.create({ data: { quoteId: q.id, customerId: user.id, addressId: d.addressId, acceptedChefId: null, totalFen: q.totalFen, depositFen: q.depositFen, balanceFen: q.totalFen-amountFen, receivedFen: amountFen, contractStatus: 'PENDING_ACCEPTANCE', paymentStatus: choice === 'DEPOSIT' ? 'DEPOSIT_PAID' : 'FULLY_PAID', ruleSnapshot: d.rules, details: { ...d, selectedChefId: d.mode === 'SELF' ? q.chefId : null, initialChoice: choice, acceptanceDeadline: new Date(this.clock().getTime() + (d.mode === 'SELF' ? 5 : d.rules.matchMinutes) * 60000).toISOString() } } });
      if (d.couponId) await tx.coupon.update({ where: { id: d.couponId }, data: { status: 'USED', orderId: order.id } });
      await this.payment(tx, order, amountFen, choice, key);
      await tx.quote.update({ where: { id }, data: { status: 'PAID' } });
      if (d.mode === 'SELF') await tx.bookingLock.upsert({ where: { quoteId: q.id }, update: { orderId: order.id, expiresAt: null }, create: { quoteId: q.id, orderId: order.id, chefId: q.chefId, startsAt: new Date(new Date(d.startsAt).getTime()-HOUR), endsAt: new Date(new Date(d.endsAt).getTime()+HOUR) } });
      const chefs = await tx.chef.findMany({ where: { ...(d.mode === 'SELF' ? { id: q.chefId } : {}), acceptingOrders: true } });
      const candidates = [];
      for (const chef of chefs) if (await this.available(tx, chef.id, d, q.id)) candidates.push({ chef, distanceM: this.distance(d.latitude, d.longitude, obj(chef.data).latitude, obj(chef.data).longitude) });
      candidates.sort((a,b) => a.distanceM - b.distanceM);
      const chosen = candidates.slice(0,3);
      for (const { chef, distanceM } of chosen) await tx.chefOrder.create({ data: { orderId: order.id, chefId: chef.id, distanceM, urgent: d.urgent, ruleVersion: q.ruleVersion, expiresAt: new Date(obj(order.details).acceptanceDeadline) } });
      await tx.insurancePolicy.create({ data: { orderId: order.id, reference: 'SANDBOX-' + order.id } });
      await this.audit(tx, user.id, 'SANDBOX_PAYMENT_SUCCEEDED', order.id, { amountFen, provider: 'sandbox' });
      await this.event(tx, '首付款成功，等待厨师接单（沙箱）', order, chosen.map(c => c.chef.userId));
      return this.viewOrder(tx, user, order);
    });
  }
  async authorizedOrder(tx: Tx, user: User, id: string) {
    const order = await tx.order.findUnique({ where: { id } }); ensure(order, 'NOT_FOUND', '订单不存在', 404);
    const chef = await tx.chef.findUnique({ where: { userId: user.id } });
    const invite = chef ? await tx.chefOrder.findUnique({ where: { orderId_chefId: { orderId: id, chefId: chef.id } } }) : null;
    const staff = user.roles.some(r => ['OPERATOR','REVIEWER','CUSTOMER_SERVICE','FINANCE','FINANCE_MANAGER','ADMIN','RISK'].includes(r));
    ensure(order.customerId === user.id || order.acceptedChefId === chef?.id || (invite?.status === 'INVITED' && order.contractStatus === 'PENDING_ACCEPTANCE') || staff, 'FORBIDDEN', '无权访问订单', 403);
    return order;
  }
  async viewOrder(tx: Tx, user: User, order: Order) {
    const d = obj(order.details), { encryptedAddress, latitude, longitude, ...safe } = d;
    const chef = await tx.chef.findUnique({ where: { userId: user.id } });
    const owns = user.id === order.customerId;
    const maySeeAddress = owns || (chef?.id === order.acceptedChefId && order.contractStatus === 'ACCEPTED' && (d.earlyAddressConsent || this.clock().getTime() >= new Date(d.startsAt).getTime()-24*HOUR));
    let fullAddress: string | undefined;
    if (maySeeAddress && encryptedAddress) { fullAddress = decrypt(encryptedAddress); await this.audit(tx, user.id, 'ADDRESS_READ', order.id); }
    const policy = await tx.insurancePolicy.findUnique({ where: { orderId: order.id } });
    const events = await tx.auditEvent.findMany({ where: { aggregateId: order.id }, select: { action: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    return { ...order, details: { ...safe, fullAddress }, policy, timeline: events, sandbox: process.env.APP_MODE==='sandbox' };
  }
  async orders(user: User) {
    return this.transaction(async tx => {
      const chef = await tx.chef.findUnique({ where: { userId: user.id } });
      const staff = user.roles.some(r => ['OPERATOR','CUSTOMER_SERVICE','FINANCE','FINANCE_MANAGER','ADMIN','RISK'].includes(r));
      const rows = await tx.order.findMany({ where: staff ? {} : { OR: [{ customerId: user.id }, ...(chef ? [{ acceptedChefId: chef.id }, { contractStatus: 'PENDING_ACCEPTANCE' as const, chefOrders: { some: { chefId: chef.id, status: 'INVITED' as const } } }] : [])] }, orderBy: { createdAt: 'desc' }, take: 100 });
      return Promise.all(rows.map(o => this.viewOrder(tx, user, o)));
    });
  }
  async getOrder(user: User, id: string) { return this.transaction(async tx => this.viewOrder(tx, user, await this.authorizedOrder(tx,user,id))); }
  async accept(user: User, id: string) {
    return this.transaction(async tx => {
      const c = await tx.chef.findUnique({ where: { userId: user.id } }); ensure(c, 'NOT_CHEF', '仅厨师可接单', 403);
      const o = await this.authorizedOrder(tx,user,id), d = obj(o.details);
      if (o.acceptedChefId === c.id && o.contractStatus === 'ACCEPTED') return this.viewOrder(tx,user,o);
      ensure(o.contractStatus === 'PENDING_ACCEPTANCE' && new Date(d.acceptanceDeadline) > this.clock(), 'ACCEPTANCE_EXPIRED', '订单已接单或超过接单期限');
      const candidate = await tx.chefOrder.findUnique({ where: { orderId_chefId: { orderId: id, chefId: c.id } } });
      ensure(candidate?.status === 'INVITED', 'NOT_INVITED', '非候选厨师', 403);
      ensure(await this.available(tx,c.id,d,o.quoteId), 'SCHEDULE_CONFLICT', '档期冲突或认证已失效');
      await tx.bookingLock.upsert({ where: { quoteId: o.quoteId }, update: { chefId: c.id, orderId: id, expiresAt: null }, create: { chefId: c.id, quoteId: o.quoteId, orderId: id, startsAt: new Date(new Date(d.startsAt).getTime()-HOUR), endsAt: new Date(new Date(d.endsAt).getTime()+HOUR) } });
      await tx.chefOrder.updateMany({ where: { orderId: id }, data: { status: 'DECLINED' } });
      await tx.chefOrder.update({ where: { id: candidate.id }, data: { status: 'ACCEPTED' } });
      const updated = await tx.order.update({ where: { id }, data: { acceptedChefId: c.id, contractStatus: 'ACCEPTED', fulfillmentStatus: 'READY' } });
      await this.audit(tx,user.id,'CHEF_ACCEPTED',id); await this.event(tx,'厨师已接单',updated,[c.userId]); return this.viewOrder(tx,user,updated);
    });
  }
  async refund(tx: Tx, o: Order, amountFen: number, key: string) {
    const old = await tx.ledgerEntry.findUnique({ where: { reference: key } }); if (old) return;
    ensure(amountFen >= 0 && amountFen <= o.receivedFen-o.refundedFen, 'INVALID_REFUND', '退款不能超过净实收');
    if (amountFen) {
      ensure(process.env.APP_MODE==='sandbox','REFUND_UNAVAILABLE','退款渠道尚未开通',503);
      await tx.paymentRequest.create({ data: { orderId: o.id, amountFen, kind: 'REFUND', status: 'SUCCEEDED', provider: 'sandbox', providerRef: 'sandbox_'+randomUUID(), idempotencyKey: key } });
      await tx.ledgerEntry.create({ data: { orderId: o.id, reference: key, kind: 'REFUND', amountFen: -amountFen } });
    }
    await tx.order.update({ where: { id: o.id }, data: { refundedFen: o.refundedFen+amountFen, paymentStatus: o.refundedFen+amountFen === o.receivedFen ? 'FULLY_REFUNDED' : 'PARTIALLY_REFUNDED' } });
  }
  async cancelTx(tx: Tx, o: Order, actorId: string | null, reason: string) {
    if (o.contractStatus === 'CANCELLED') return o;
    if(o.contractStatus==='PENDING_PAYMENT'){
      const updated=await tx.order.update({where:{id:o.id},data:{contractStatus:'CANCELLED',fulfillmentStatus:'STOPPED',balanceFen:0}});
      await tx.quote.update({where:{id:o.quoteId},data:{status:'CANCELLED'}});await tx.bookingLock.deleteMany({where:{quoteId:o.quoteId}});
      await this.audit(tx,actorId,'UNPAID_ORDER_CANCELLED',o.id,{reason});return updated;
    }
    ensure(['PENDING_ACCEPTANCE','ACCEPTED'].includes(o.contractStatus), 'NOT_CANCELLABLE', '此状态不可直接取消');
    await this.refund(tx,o,o.receivedFen-o.refundedFen,'cancel:'+o.id);
    const updated = await tx.order.update({ where: { id: o.id }, data: { contractStatus: 'CANCELLED', fulfillmentStatus: 'STOPPED', feeStatus: 'SETTLED', settlementStatus: 'INELIGIBLE', balanceFen: 0 } });
    await tx.bookingLock.deleteMany({ where: { orderId: o.id } });
    await tx.chefOrder.updateMany({ where: { orderId: o.id }, data: { status: 'EXPIRED' } });
    await tx.coupon.updateMany({ where: { orderId: o.id }, data: { status: 'AVAILABLE', orderId: null } });
    await tx.insurancePolicy.updateMany({ where: { orderId: o.id }, data: { status: 'SANDBOX_CANCELLED' } });
    await this.audit(tx,actorId,'ORDER_CANCELLED',o.id,{reason}); await this.event(tx,process.env.APP_MODE==='sandbox'?'订单已取消，沙箱退款完成':'订单已取消，已收款项将原路退回',updated); return updated;
  }
  async cancel(user: User,id: string,b: Data) {
    return this.transaction(async tx => {
      const o = await this.authorizedOrder(tx,user,id), c = await tx.chef.findUnique({ where: { userId: user.id } }), d = obj(o.details);
      const own = o.customerId === user.id, assigned = c?.id === o.acceptedChefId || c?.id === d.selectedChefId;
      ensure(own || assigned, 'FORBIDDEN', '仅交易双方可取消；运营请走售后审批',403);
      ensure(!['SERVING','AWAITING_CONFIRMATION','COMPLETED'].includes(o.fulfillmentStatus), 'AFTERSALE_REQUIRED', '已开始服务，请申请售后');
      if (own && o.contractStatus === 'ACCEPTED') ensure(new Date(d.startsAt).getTime()-this.clock().getTime() >= 24*HOUR && d.initialChoice === 'DEPOSIT', 'RULE_PENDING', '此取消场景收费规则尚未发布，请提交售后工单');
      const result = await this.cancelTx(tx,o,user.id,text(b.reason ?? '用户取消','取消原因',300)); return this.viewOrder(tx,user,result);
    });
  }
  async fulfill(user: User,id: string,b: Data) {
    return this.transaction(async tx => {
      const o = await this.authorizedOrder(tx,user,id), c = await tx.chef.findUnique({ where: { userId: user.id } }), d = obj(o.details);
      ensure(c?.id === o.acceptedChefId, 'FORBIDDEN', '只有本单厨师可以履约',403);
      const transitions: Data = { depart: ['READY','DEPARTED'], arrive: ['DEPARTED','ARRIVED'], start: ['ARRIVED','SERVING'], complete: ['SERVING','AWAITING_CONFIRMATION'] };
      const pair = transitions[b.action]; ensure(pair, 'INVALID_ACTION', '履约动作无效',400);
      if (o.fulfillmentStatus === pair[1]) return this.viewOrder(tx,user,o);
      ensure(o.contractStatus === 'ACCEPTED' && o.fulfillmentStatus === pair[0], 'INVALID_TRANSITION', '请按履约顺序操作');
      ensure(c.healthValidUntil && c.healthValidUntil > this.clock() && ['APPROVED','TRIAL'].includes(c.status), 'CHEF_INELIGIBLE', '认证失效，禁止履约');
      ensure(o.aftersaleStatus === 'NONE' && !d.pendingChange, 'DISPUTED', '请先处理售后或待确认变更');
      const policy = await tx.insurancePolicy.findUnique({ where: { orderId: id } });
      if(process.env.APP_MODE==='sandbox')ensure(policy?.status === 'SANDBOX_ACTIVE', 'INSURANCE_REQUIRED', '保障未生效，禁止履约');
      ensure(this.clock().getTime() >= new Date(d.startsAt).getTime()-24*HOUR, 'TOO_EARLY', '尚未到服务前24小时');
      if (b.action === 'start') ensure(this.clock().getTime() >= new Date(d.startsAt).getTime()-30*60000, 'TOO_EARLY', '尚未到约定服务时间');
      const evidence = text(b.evidence, '履约说明', 500);
      let extra: Data = {};
      if (b.action === 'complete') {
        const asset = await tx.fileAsset.findUnique({ where: { id: text(b.assetId,'成品照片') } }); ensure(asset?.userId === user.id && asset.orderId === id, 'INVALID_EVIDENCE', '请上传本单成品照片');
        const actualIngredientFen = integer(b.actualIngredientFen, '实际食材费',0,d.ingredientFen);
        if (actualIngredientFen > 0) { const receipt = await tx.fileAsset.findUnique({ where: { id: text(b.receiptId,'采购小票') } }); ensure(receipt?.userId === user.id && receipt.orderId === id, 'INVALID_RECEIPT', '请上传本单采购小票'); }
        extra = { serviceEndsAt: this.clock(), feeStatus: 'AWAITING_CONFIRMATION', settlementStatus: 'AWAITING_CONFIRMATION', details: { ...d, actualIngredientFen, finalFen: d.serviceFen+actualIngredientFen-d.discountFen, assetId: asset.id, receiptId: b.receiptId ?? null } };
      }
      const updated = await tx.order.update({ where: { id }, data: { fulfillmentStatus: pair[1], ...extra } });
      await this.audit(tx,user.id,'FULFILL_'+b.action.toUpperCase(),id,{ evidence }); await this.event(tx,'履约状态更新：'+pair[1],updated); return this.viewOrder(tx,user,updated);
    });
  }
  async confirmFeesTx(tx: Tx,o: Order) {
    const d = obj(o.details); ensure(Number.isSafeInteger(d.finalFen), 'FEES_NOT_SUBMITTED', '厨师尚未提交最终费用');
    const net = o.receivedFen-o.refundedFen, difference = d.finalFen-net;
    if (difference < 0) await this.refund(tx,o,-difference,'fee-refund:'+o.id);
    return tx.order.update({ where: { id: o.id }, data: { balanceFen: Math.max(difference,0), feeStatus: difference > 0 ? 'AWAITING_PAYMENT' : 'SETTLED', details: { ...d, feesConfirmedAt: this.clock().toISOString() }, settlementStatus: o.confirmedAt ? difference > 0 ? 'FROZEN' : 'PENDING' : o.settlementStatus } });
  }
  async confirmTx(tx: Tx,o: Order,actorId: string | null) {
    if (o.confirmedAt) return o;
    ensure(o.fulfillmentStatus === 'AWAITING_CONFIRMATION' && o.aftersaleStatus === 'NONE', 'NOT_CONFIRMABLE', '尚未完成服务或存在争议');
    const d = obj(o.details); ensure(d.assetId && (d.actualIngredientFen === 0 || d.receiptId), 'MISSING_EVIDENCE','缺少履约凭证');
    const u = await tx.order.update({ where: { id: o.id }, data: { contractStatus:'FULFILLED', fulfillmentStatus:'COMPLETED', confirmedAt:this.clock(), reviewStatus:'OPEN', settlementStatus: o.feeStatus === 'SETTLED' ? 'PENDING' : 'FROZEN' } });
    await tx.bookingLock.deleteMany({ where: { orderId:o.id } }); await this.audit(tx,actorId,'SERVICE_CONFIRMED',o.id); await this.event(tx,'服务已确认完成，评价已开放',u); return u;
  }
  async customerAction(user:User,id:string,action:string,b:Data) {
    return this.transaction(async tx => {
      let o=await this.authorizedOrder(tx,user,id); ensure(o.customerId===user.id,'FORBIDDEN','仅订单用户可操作',403);
      if(action==='address-consent') { ensure(o.contractStatus==='ACCEPTED','INVALID_STATE','接单后可授权'); o=await tx.order.update({where:{id},data:{details:{...obj(o.details),earlyAddressConsent:true}}}); }
      else if(action==='confirm-fees') { ensure(o.aftersaleStatus==='NONE','DISPUTED','争议处理期间不能确认费用'); o=await this.confirmFeesTx(tx,o); }
      else if(action==='confirm') o=await this.confirmTx(tx,o,user.id);
      else if(action==='balance') {
        const key=user.id+':balance:'+text(b.idempotencyKey,'幂等键',100), old=await tx.paymentRequest.findUnique({where:{idempotencyKey:key}});
        if(old) { ensure(old.orderId===id,'IDEMPOTENCY_CONFLICT','幂等键冲突'); return this.viewOrder(tx,user,o); }
        ensure(o.balanceFen>0 && o.feeStatus==='AWAITING_PAYMENT' && o.aftersaleStatus==='NONE' && o.contractStatus!=='CANCELLED','BALANCE_NOT_PAYABLE','请先确认最终费用');
        await this.payment(tx,o,o.balanceFen,'BALANCE',key);
        o=await tx.order.update({where:{id},data:{receivedFen:o.receivedFen+o.balanceFen,balanceFen:0,paymentStatus:'FULLY_PAID',feeStatus:'SETTLED',settlementStatus:o.confirmedAt?'PENDING':o.settlementStatus}});
      } else throw new ApiError(404,'NOT_FOUND','操作不存在');
      await this.audit(tx,user.id,'CUSTOMER_'+action.toUpperCase(),id); return this.viewOrder(tx,user,o);
    });
  }
  async tick() {
    return this.transaction(async tx => {
      await tx.bookingLock.deleteMany({where:{expiresAt:{lte:this.clock()}}});
      const pending=await tx.order.findMany({where:{contractStatus:'PENDING_ACCEPTANCE'}});
      let expired=0,confirmed=0;
      const unpaid=await tx.order.findMany({where:{contractStatus:'PENDING_PAYMENT'}});
      for(const o of unpaid)if(new Date(obj(o.details).paymentDeadline)<=this.clock()){await this.cancelTx(tx,o,null,'付款期限已过');expired++;}
      for(const o of pending) if(new Date(obj(o.details).acceptanceDeadline)<=this.clock()){await this.cancelTx(tx,o,null,'接单超时');expired++;}
      const waiting=await tx.order.findMany({where:{fulfillmentStatus:'AWAITING_CONFIRMATION',aftersaleStatus:'NONE',serviceEndsAt:{lte:new Date(this.clock().getTime()-72*HOUR)}}});
      for(let o of waiting) { const d=obj(o.details); if(!d.assetId || (d.actualIngredientFen>0&&!d.receiptId)) continue; if(!d.feesConfirmedAt)o=await this.confirmFeesTx(tx,o); await this.confirmTx(tx,o,null);confirmed++; }
      await tx.order.updateMany({where:{reviewStatus:'OPEN',confirmedAt:{lt:new Date(this.clock().getTime()-7*24*HOUR)}},data:{reviewStatus:'EXPIRED'}});
      await tx.chef.updateMany({where:{healthValidUntil:{lte:this.clock()},acceptingOrders:true},data:{acceptingOrders:false,status:'SUSPENDED'}});
      const events=await tx.outboxEvent.findMany({where:{publishedAt:null},orderBy:{occurredAt:'asc'},take:100});
      for(const e of events){ const p=obj(e.payload); for(const userId of p.recipients??[])await tx.notification.upsert({where:{id:e.id+':'+userId},create:{id:e.id+':'+userId,userId,orderId:e.aggregateId,body:p.body??e.eventType},update:{}});await tx.outboxEvent.update({where:{id:e.id},data:{publishedAt:this.clock(),attempts:{increment:1}}}); }
      return {expired,confirmed,published:events.length};
    });
  }
}
export { obj, HOUR };