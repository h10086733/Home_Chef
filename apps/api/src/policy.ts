import { ensure, integer } from './errors';
type Data=Record<string,any>;
const HOUR=3600000,DAY=24*HOUR;

/** SRS V1.0 ch.8 parameters. Orders keep the snapshot taken at quote time, so a rule change never rewrites existing orders. */
export const SRS_DEFAULTS={
  srsVersion:'1.0',
  commissionBase:'NET' as 'NET'|'SERVICE',
  settlementTrigger:'CONFIRM_DELAY' as 'CONFIRM_DELAY'|'REVIEW_OR_EXPIRE',
  settleDelayHours:24,
  autoConfirmHours:48,
  payTimeoutMinutes:30,
  acceptTimeoutMinutes:30,
  minAdvanceHours:2,
  maxAdvanceDays:30,
  cancelFreeHours:24,
  cancelHalfHours:6,
  cancelRateMid:.3,
  cancelRateLate:.5,
  cancelRateArrived:1,
  withdrawMinFen:10000,
  withdrawDailyLimit:3,
  withdrawRevocable:false,
  healthCertWarnDays:30,
  insuranceRequired:true,
  insuranceGraceDays:60,
};
export type SrsRules=typeof SRS_DEFAULTS;

export function srs(rules:unknown):SrsRules|null{
  const r=(rules??{}) as Data;
  return r.srsVersion==='1.0'?{...SRS_DEFAULTS,...pick(r)}:null;
}
function pick(r:Data){return Object.fromEntries(Object.keys(SRS_DEFAULTS).filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));}
const rate=(v:unknown,name:string)=>{ensure(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1,'INVALID_RULE',name+'无效',400);return v;};

/** Validates SRS fields from an admin publish request; missing fields fall back to SRS defaults. */
export function srsInput(b:Data):SrsRules{
  const r={...SRS_DEFAULTS,...pick(b),srsVersion:'1.0'};
  ensure(['NET','SERVICE'].includes(r.commissionBase),'INVALID_RULE','佣金基数无效',400);
  ensure(['CONFIRM_DELAY','REVIEW_OR_EXPIRE'].includes(r.settlementTrigger),'INVALID_SETTLEMENT_RULE','结算触发规则无效',400);
  integer(r.settleDelayHours,'确认后结算小时',0,720);integer(r.autoConfirmHours,'自动确认小时',1,168);
  integer(r.payTimeoutMinutes,'支付超时分钟',5,120);integer(r.acceptTimeoutMinutes,'接单超时分钟',5,120);
  integer(r.minAdvanceHours,'最少提前小时',1,72);integer(r.maxAdvanceDays,'最多提前天数',1,90);
  integer(r.cancelFreeHours,'免费取消小时',1,168);integer(r.cancelHalfHours,'高额取消小时',0,r.cancelFreeHours);
  rate(r.cancelRateMid,'中段取消扣费比例');rate(r.cancelRateLate,'临近取消扣费比例');rate(r.cancelRateArrived,'到达后取消扣费比例');
  integer(r.withdrawMinFen,'最低提现金额',1,10000000);integer(r.withdrawDailyLimit,'每日提现次数',1,20);
  ensure(typeof r.withdrawRevocable==='boolean'&&typeof r.insuranceRequired==='boolean','INVALID_RULE','开关配置无效',400);
  integer(r.healthCertWarnDays,'健康证提醒天数',1,90);integer(r.insuranceGraceDays,'保险缓冲天数',0,365);
  return r as SrsRules;
}

export type CancelTier='FREE'|'MID'|'LATE'|'ARRIVED'|'BEFORE_ACCEPT';
/**
 * SRS 8.4 customer cancellation. Deduction is a share of the chef service fee (baseFen),
 * capped by what the customer actually paid net of earlier refunds.
 */
export function cancellation(input:{accepted:boolean,arrived:boolean,startsAt:Date,now:Date,baseFen:number,netFen:number,rules:SrsRules}){
  const {rules}=input;let tier:CancelTier,ratio:number;
  if(!input.accepted){tier='BEFORE_ACCEPT';ratio=0;}
  else if(input.arrived){tier='ARRIVED';ratio=rules.cancelRateArrived;}
  else{
    const left=input.startsAt.getTime()-input.now.getTime();
    if(left>=rules.cancelFreeHours*HOUR){tier='FREE';ratio=0;}
    else if(left>=rules.cancelHalfHours*HOUR){tier='MID';ratio=rules.cancelRateMid;}
    else{tier='LATE';ratio=rules.cancelRateLate;}
  }
  const deductFen=Math.min(Math.max(0,input.netFen),Math.round(Math.max(0,input.baseFen)*ratio));
  return {tier,ratio,deductFen,refundFen:Math.max(0,input.netFen)-deductFen};
}

/** SRS 8.5: settlement plan time. Returns null while still waiting on review for review-gated rules. */
export function settlementEligibleAt(o:{confirmedAt:Date|null,reviewStatus:string,ruleSnapshot:unknown},legacyHoldHours:number){
  if(!o.confirmedAt)return null;
  const r=(o.ruleSnapshot??{}) as Data;
  if(r.settlementTrigger==='CONFIRM_DELAY')return new Date(o.confirmedAt.getTime()+(Number(r.settleDelayHours??r.settlementDelayHours)||0)*HOUR);
  if(r.settlementTrigger!=='REVIEW_OR_EXPIRE')return new Date(o.confirmedAt.getTime()+legacyHoldHours*HOUR);
  if(!['REVIEWED','EXPIRED'].includes(o.reviewStatus))return null;
  return new Date(o.confirmedAt.getTime()+(Number(r.settlementDelayHours)||0)*HOUR);
}

export function commissionFen(rules:unknown,serviceFen:number,netFen:number){
  const r=(rules??{}) as Data,ratio=Number(r.commissionRate)||0;
  return Math.round((r.srsVersion==='1.0'&&(r.commissionBase??'NET')==='NET'?netFen:serviceFen)*ratio);
}

/**
 * Chef income left after an adjudicated refund. The commission base shrinks to the remaining
 * net when that is below the original service fee, so a service refund also reverses its commission.
 */
export function remainingChefFen(rules:unknown,serviceFen:number,netFen:number,subsidyFen=0){
  const net=Math.max(0,Math.trunc(netFen)),base=Math.min(Math.max(0,Math.trunc(serviceFen)),net);
  const commission=commissionFen(rules,base,net),chefFen=net+Math.trunc(subsidyFen)-commission;
  return {commissionFen:commission,chefFen};
}

/** SRS 8.6: withdrawal limits; counts are supplied by the caller from the database. */
export function withdrawalCheck(rules:SrsRules,input:{amountFen:number,todayCount:number,inProgress:number}){
  ensure(input.amountFen>=rules.withdrawMinFen,'WITHDRAW_MIN','单笔提现不低于 '+(rules.withdrawMinFen/100)+' 元',400);
  ensure(input.inProgress===0,'WITHDRAW_IN_PROGRESS','已有提现处理中，完成后再申请');
  ensure(input.todayCount<rules.withdrawDailyLimit,'WITHDRAW_DAILY_LIMIT','今日提现次数已达上限（'+rules.withdrawDailyLimit+' 次）');
}

/** SRS 3.3.6 insurance: valid, or expired within the grace window. */
export function insuranceOk(rules:SrsRules|null,validUntil:Date|null|undefined,now:Date){
  if(!rules?.insuranceRequired)return true;
  if(!validUntil)return false;
  return validUntil.getTime()+rules.insuranceGraceDays*DAY>now.getTime();
}

/** SRS 8.9 IM rules: R001–R004 block, R006–R007 replace with ***. */
const BLOCK:[string,RegExp][]=[
  ['R001',/(?<![0-9０-９])[1１][3-9３-９][0-9０-９][\s\-]?[0-9０-９]{4}[\s\-]?[0-9０-９]{4}(?![0-9０-９])/],
  ['R002',/[零〇一二三四五六七八九幺壹贰叁肆伍陆柒捌玖]{11,}/],
  ['R003',/(微信|vx|v信|威信|weixin|wechat|wx)[\s:：号是为]{0,10}[a-z][-_a-z0-9]{5,19}/i],
  ['R004',/(qq|扣扣)[\s:：号是为]{0,5}[0-9]{5,11}/i],
  ['R005',/(支付宝|alipay|https?:\/\/|www\.)/i],
];
const MASK:[string,RegExp][]=[
  ['R006',/(私下|转账|红包|扫码付|现金|线下支付|线下交易|加我)/g],
  ['R007',/(傻逼|操你|妈的|滚蛋|贱人)/g],
];
export function imRisk(body:string){
  const hit=BLOCK.find(([,re])=>re.test(body));
  if(hit)return {action:'BLOCK' as const,rule:hit[0],body};
  let masked=body;const rules:string[]=[];
  for(const [id,re] of MASK){if(re.test(masked)){rules.push(id);masked=masked.replace(re,'***');}re.lastIndex=0;}
  return rules.length?{action:'MASK' as const,rule:rules.join(','),body:masked}:{action:'PASS' as const,rule:null,body};
}

/** SRS 7.2 egress scan: plaintext mainland mobile numbers in JSON responses. */
const PHONE=/(?<![0-9A-Za-z+/=_-])1[3-9]\d{9}(?![0-9A-Za-z+/=_-])/g;
export function maskPhones(text:string){
  let count=0;const out=text.replace(PHONE,m=>{count++;return m.slice(0,3)+'****'+m.slice(7);});
  return {count,text:out};
}

export const DELETION_DELAY_DAYS=15;
export const LOGIN_MAX_FAILS=5,LOGIN_LOCK_MINUTES=30;
