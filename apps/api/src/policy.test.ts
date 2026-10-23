import test from 'node:test';
import assert from 'node:assert/strict';
import { SRS_DEFAULTS, cancellation, commissionFen, imRisk, insuranceOk, maskPhones, remainingChefFen, settlementEligibleAt, srs, srsInput, withdrawalCheck } from './policy';

const H=3600000,now=new Date('2026-10-23T10:00:00+08:00'),at=(h:number)=>new Date(now.getTime()+h*H);
const base={accepted:true,arrived:false,now,baseFen:20000,netFen:30000,rules:SRS_DEFAULTS};

test('legacy rules are not treated as SRS',()=>{assert.equal(srs({commissionRate:.15}),null);assert.equal(srs({srsVersion:'1.0'})!.settleDelayHours,24);});

test('cancellation tiers follow SRS 8.4 boundaries',()=>{
  assert.deepEqual(cancellation({...base,accepted:false,startsAt:at(1)}),{tier:'BEFORE_ACCEPT',ratio:0,deductFen:0,refundFen:30000});
  assert.equal(cancellation({...base,startsAt:at(24)}).tier,'FREE');
  assert.deepEqual(cancellation({...base,startsAt:at(23.99)}),{tier:'MID',ratio:.3,deductFen:6000,refundFen:24000});
  assert.equal(cancellation({...base,startsAt:at(6)}).tier,'MID');
  assert.deepEqual(cancellation({...base,startsAt:at(5.99)}),{tier:'LATE',ratio:.5,deductFen:10000,refundFen:20000});
  assert.deepEqual(cancellation({...base,arrived:true,startsAt:at(30)}),{tier:'ARRIVED',ratio:1,deductFen:20000,refundFen:10000});
  assert.equal(cancellation({...base,arrived:true,startsAt:at(1),netFen:5000}).deductFen,5000);
});

test('settlement time per trigger',()=>{
  const confirmedAt=now;
  assert.deepEqual(settlementEligibleAt({confirmedAt,reviewStatus:'OPEN',ruleSnapshot:{settlementTrigger:'CONFIRM_DELAY',settleDelayHours:24}},168),at(24));
  assert.equal(settlementEligibleAt({confirmedAt,reviewStatus:'OPEN',ruleSnapshot:{settlementTrigger:'REVIEW_OR_EXPIRE'}},168),null);
  assert.deepEqual(settlementEligibleAt({confirmedAt,reviewStatus:'REVIEWED',ruleSnapshot:{settlementTrigger:'REVIEW_OR_EXPIRE',settlementDelayHours:2}},168),at(2));
  assert.deepEqual(settlementEligibleAt({confirmedAt,reviewStatus:'OPEN',ruleSnapshot:{}},168),at(168));
  assert.equal(settlementEligibleAt({confirmedAt:null,reviewStatus:'OPEN',ruleSnapshot:{}},168),null);
});

test('commission base',()=>{
  assert.equal(commissionFen({commissionRate:.15},19800,30000),2970);
  assert.equal(commissionFen({srsVersion:'1.0',commissionRate:.1,commissionBase:'NET'},19800,30000),3000);
  assert.equal(commissionFen({srsVersion:'1.0',commissionRate:0},19800,30000),0);
});

test('adjudicated refund reverses chef income and the matching commission',()=>{
  const rules={commissionRate:.15};
  assert.deepEqual(remainingChefFen(rules,100000,100000),{commissionFen:15000,chefFen:85000});
  const next=remainingChefFen(rules,100000,80000);
  assert.deepEqual(next,{commissionFen:12000,chefFen:68000});
  assert.equal(85000-next.chefFen,17000);
  assert.equal(remainingChefFen({srsVersion:'1.0',commissionRate:0,commissionBase:'NET'},100000,80000).chefFen,80000);
  assert.equal(remainingChefFen(rules,100000,110000,0).commissionFen,15000);
});

test('withdrawal limits',()=>{
  assert.throws(()=>withdrawalCheck(SRS_DEFAULTS,{amountFen:9999,todayCount:0,inProgress:0}),/不低于 100 元/);
  assert.throws(()=>withdrawalCheck(SRS_DEFAULTS,{amountFen:10000,todayCount:0,inProgress:1}),/处理中/);
  assert.throws(()=>withdrawalCheck(SRS_DEFAULTS,{amountFen:10000,todayCount:3,inProgress:0}),/上限/);
  assert.doesNotThrow(()=>withdrawalCheck(SRS_DEFAULTS,{amountFen:10000,todayCount:2,inProgress:0}));
});

test('insurance grace window',()=>{
  assert.equal(insuranceOk(SRS_DEFAULTS,null,now),false);
  assert.equal(insuranceOk(SRS_DEFAULTS,at(-59*24),now),true);
  assert.equal(insuranceOk(SRS_DEFAULTS,at(-61*24),now),false);
  assert.equal(insuranceOk({...SRS_DEFAULTS,insuranceRequired:false},null,now),true);
  assert.equal(insuranceOk(null,null,now),true);
});

test('rule publish validation',()=>{
  assert.equal(srsInput({}).settlementTrigger,'CONFIRM_DELAY');
  assert.throws(()=>srsInput({cancelRateMid:1.5}),/无效/);
  assert.throws(()=>srsInput({cancelFreeHours:6,cancelHalfHours:12}));
  assert.throws(()=>srsInput({settlementTrigger:'NOW'}),/结算触发/);
});

test('IM rules R001-R007',()=>{
  for(const body of ['电话13812345678','138 1234 5678','１３８１２３４５６７８','一三八一二三四五六七八','加我微信 wx abc123','vx: chef_2026','QQ 12345678','支付宝付','看 https://x.cn'])assert.equal(imRisk(body).action,'BLOCK',body);
  assert.deepEqual(imRisk('我们私下转账吧'),{action:'MASK',rule:'R006',body:'我们******吧'});
  assert.equal(imRisk('少放辣椒，谢谢').action,'PASS');
  assert.equal(imRisk('微信支付就行').action,'PASS');
});

test('egress phone masking leaves ids intact',()=>{
  assert.deepEqual(maskPhones('{"phone":"13812345678"}'),{count:1,text:'{"phone":"138****5678"}'});
  for(const s of ['e13812345678','138123456789','1761234567890','a-13812345678'])assert.equal(maskPhones(s).count,0,s);
});
