import { Prisma, User } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Service, obj, HOUR } from './service';
import { ensure, text, integer } from './errors';
import { digest } from './security';
type Data=Record<string,any>;
export class MvpService extends Service {


  async cancelQuote(user:User,id:string){
    return this.transaction(async tx=>{
      const q=await tx.quote.findUnique({where:{id}});ensure(q?.customerId===user.id,'NOT_FOUND','报价不存在',404);
      ensure(!['PAID','SUBMITTED'].includes(q.status),'QUOTE_PAID','已支付报价不能撤回');
      await tx.bookingLock.deleteMany({where:{quoteId:id,orderId:null}});
      await tx.quote.update({where:{id},data:{status:'CANCELLED'}});
      await this.audit(tx,user.id,'QUOTE_CANCELLED',id);return {ok:true};
    });
  }

  async change(user:User,id:string,b:Data){
    return this.transaction(async tx=>{
      const o=await this.authorizedOrder(tx,user,id),d=obj(o.details),c=await tx.chef.findUnique({where:{userId:user.id}});
      const customer=o.customerId===user.id,chef=c?.id===o.acceptedChefId;
      ensure(customer||chef,'FORBIDDEN','仅交易双方可以协商变更',403);
      ensure(o.contractStatus==='ACCEPTED'&&['READY','DEPARTED','ARRIVED','SERVING'].includes(o.fulfillmentStatus)&&o.aftersaleStatus==='NONE','CHANGE_BLOCKED','当前状态不可改约或改价');
      const pending=d.pendingChange;
      if(b.action==='propose'){
        ensure(!pending,'CHANGE_PENDING','请先处理当前变更');
        ensure(['SCHEDULE','BUDGET','MENU'].includes(b.kind),'INVALID_CHANGE','变更类型无效',400);
        const proposal:Data={id:randomUUID(),kind:b.kind,createdBy:user.id,reason:text(b.reason,'变更说明',500),createdAt:this.clock().toISOString()};
        if(b.kind==='SCHEDULE'){
          ensure(o.fulfillmentStatus==='READY','CHANGE_TOO_LATE','已出发后请走客服改约');
          const startsAt=new Date(text(b.startsAt,'新时间')),duration=new Date(d.endsAt).getTime()-new Date(d.startsAt).getTime(),advance=startsAt.getTime()-this.clock().getTime();
          ensure(Number.isFinite(advance)&&advance>=24*HOUR&&advance<=30*24*HOUR&&startsAt.getMinutes()%30===0&&startsAt.getSeconds()===0,'BOOKING_WINDOW','改约须提前24小时至30天，按半小时选择');
          proposal.startsAt=startsAt.toISOString();proposal.endsAt=new Date(startsAt.getTime()+duration).toISOString();
          ensure(await this.available(tx,o.acceptedChefId!,{...d,...proposal},o.quoteId),'SCHEDULE_CONFLICT','新档期不可用，原档期保持');
        }else if(b.kind==='BUDGET'){
          ensure(chef&&d.ingredientMode==='CHEF','INVALID_BUDGET','仅本单厨师可提交采购增量');
          proposal.ingredientFen=integer(b.ingredientFen,'新采购预算',d.ingredientFen+1,100000);
          proposal.additionalFen=proposal.ingredientFen-d.ingredientFen;
        }else proposal.menu=text(b.menu,'变更菜单',1000);
        const updated=await tx.order.update({where:{id},data:{details:{...d,pendingChange:proposal}}});
        await this.audit(tx,user.id,'CHANGE_PROPOSED',id,{proposal});await this.event(tx,'有待确认的改约或费用变更',updated);return this.viewOrder(tx,user,updated);
      }
      ensure(pending&&pending.id===b.changeId,'CHANGE_NOT_FOUND','变更不存在或已处理');
      ensure(pending.createdBy!==user.id,'COUNTERPART_REQUIRED','变更须由另一方确认');
      ensure(b.action==='accept'||b.action==='reject','INVALID_ACTION','请选择同意或拒绝',400);
      let data:Data={details:{...d,pendingChange:null}};
      if(b.action==='accept'){
        if(pending.kind==='SCHEDULE'){
          ensure(await this.available(tx,o.acceptedChefId!,{...d,...pending},o.quoteId),'SCHEDULE_CONFLICT','新档期已不可用，原档期保持');
          await tx.bookingLock.update({where:{orderId:id},data:{startsAt:new Date(new Date(pending.startsAt).getTime()-HOUR),endsAt:new Date(new Date(pending.endsAt).getTime()+HOUR)}});
          data.details={...data.details,startsAt:pending.startsAt,endsAt:pending.endsAt,earlyAddressConsent:false};
        }else if(pending.kind==='BUDGET'){
          ensure(customer,'FORBIDDEN','采购增量须用户确认支付',403);
          await this.payment(tx,o,pending.additionalFen,'ADDITIONAL','change:'+pending.id);
          data={...data,totalFen:o.totalFen+pending.additionalFen,receivedFen:o.receivedFen+pending.additionalFen,details:{...data.details,ingredientFen:pending.ingredientFen}};
        }else data.details={...data.details,menu:pending.menu};
      }
      const updated=await tx.order.update({where:{id},data});
      await this.audit(tx,user.id,'CHANGE_'+b.action.toUpperCase(),id,{proposal:pending});await this.event(tx,'变更已'+(b.action==='accept'?'确认':'拒绝'),updated);return this.viewOrder(tx,user,updated);
    });
  }

  async favorites(user:User,id?:string) {
    if(!id)return this.db.favorite.findMany({where:{userId:user.id}});
    return this.transaction(async tx=>{ensure(await tx.chef.findUnique({where:{id}}),'NOT_FOUND','厨师不存在',404);const old=await tx.favorite.findUnique({where:{userId_chefId:{userId:user.id,chefId:id}}});if(old)await tx.favorite.delete({where:{id:old.id}});else await tx.favorite.create({data:{userId:user.id,chefId:id}});return {favorite:!old};});
  }
  async coupons(user:User,claim=false) {
    if(claim) return this.transaction(async tx=>{
      const rules=await this.rules(tx);ensure(rules.couponEnabled,'COUPON_DISABLED','活动尚未开放');
      return tx.coupon.upsert({where:{id:'new-user:'+user.id},update:{},create:{id:'new-user:'+user.id,userId:user.id,label:'新人家宴券',amountFen:rules.couponFen,minFen:rules.couponMinFen,regionCode:rules.regions.find((r:Data)=>r.active).code,expiresAt:new Date(this.clock().getTime()+30*24*HOUR),ruleVersion:rules.id}});
    });
    return this.db.coupon.findMany({where:{userId:user.id},orderBy:{expiresAt:'desc'}});
  }
  async messages(user:User,id:string,b?:Data) {
    const result=await this.transaction(async tx=>{
      const o=await this.authorizedOrder(tx,user,id),c=await tx.chef.findUnique({where:{userId:user.id}});
      const participant=o.customerId===user.id||c?.id===o.acceptedChefId;
      if(b){
        ensure(participant&&o.contractStatus==='ACCEPTED','CHAT_UNAVAILABLE','接单后交易双方可以聊天',403);
        const body=text(b.body,'消息',1000);
        const blocked=/(微信|微.?信|wx|wechat|QQ|[1１][3-9３-９][0-9０-９\s-]{9,}|线下.{0,5}(转账|支付)|加我|支付宝|https?:\/\/)/i.test(body);
        const row=await tx.chatMessage.create({data:{orderId:id,senderId:user.id,body,blocked}});
        await this.audit(tx,user.id,blocked?'IM_BLOCKED':'IM_SENT',id,{messageId:row.id});
        if(blocked)return {blocked:true};
        await this.event(tx,'有新的订单消息',o,c?[c.userId]:[]);return row;
      }
      ensure(participant||user.roles.some(r=>['RISK','CUSTOMER_SERVICE'].includes(r)),'FORBIDDEN','无权查看聊天',403);
      if(!participant){ensure(await tx.serviceTicket.findFirst({where:{orderId:id,status:{not:'CLOSED'}}}),'TICKET_REQUIRED','调阅聊天需要关联开放工单',403);await this.audit(tx,user.id,'CHAT_STAFF_READ',id);}
      return tx.chatMessage.findMany({where:{orderId:id,...(participant?{OR:[{blocked:false},{senderId:user.id}]}:{})},orderBy:{createdAt:'asc'},take:200});
    });
    ensure(!('blocked' in result && result.blocked===true),'SENSITIVE_MESSAGE','消息包含联系方式或线下交易信息，已拦截并留痕',400);return result;
  }
  async upload(user:User,b:Data) {
    const mime=text(b.mime,'文件类型',50);ensure(['image/png','image/jpeg'].includes(mime),'INVALID_FILE','仅支持 PNG/JPEG 图片',400);
    const encoded=text(b.base64,'图片内容',4300000);ensure(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded),'INVALID_FILE','图片编码无效',400);
    const bytes=Buffer.from(encoded,'base64');ensure(bytes.length>8&&bytes.length<=3*1024*1024,'FILE_SIZE','图片不能超过3MB',400);
    ensure(mime==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':bytes[0]===255&&bytes[1]===216&&bytes[2]===255,'INVALID_FILE','文件内容与图片类型不符',400);
    return this.transaction(async tx=>{
      if(b.orderId){const o=await this.authorizedOrder(tx,user,text(b.orderId,'订单'));const c=await tx.chef.findUnique({where:{userId:user.id}});ensure(o.customerId===user.id||o.acceptedChefId===c?.id,'FORBIDDEN','仅本单双方可以上传凭证',403);}
      const file=await tx.fileAsset.create({data:{userId:user.id,orderId:b.orderId??null,mime,bytes,sha256:digest(encoded)}});
      await this.audit(tx,user.id,'FILE_UPLOADED',file.id,{orderId:b.orderId??null});return {id:file.id,mime:file.mime};
    });
  }
  async file(user:User,id:string){
    return this.transaction(async tx=>{
      const f=await tx.fileAsset.findUnique({where:{id}});ensure(f,'NOT_FOUND','文件不存在',404);
      if(f.userId!==user.id){
        if(f.orderId){const o=await this.authorizedOrder(tx,user,f.orderId),c=await tx.chef.findUnique({where:{userId:user.id}});ensure(o.customerId===user.id||c?.id===o.acceptedChefId||user.roles.includes('CUSTOMER_SERVICE'),'FORBIDDEN','无权查看凭证',403);}
        else {this.role(user,'REVIEWER');ensure(await tx.chef.findFirst({where:{userId:f.userId}}),'FORBIDDEN','无审核材料关联',403);}
      }
      await this.audit(tx,user.id,'FILE_READ',id);return f;
    });
  }
  async ticket(user:User,id:string,b:Data){
    return this.transaction(async tx=>{
      const o=await this.authorizedOrder(tx,user,id),c=await tx.chef.findUnique({where:{userId:user.id}});
      ensure(o.customerId===user.id||c?.id===o.acceptedChefId,'FORBIDDEN','仅交易双方可以申请售后',403);
      const reason=text(b.reason,'售后原因',1000),incident=b.incident===true;
      ensure(incident||!o.confirmedAt||this.clock().getTime()-o.confirmedAt.getTime()<=7*24*HOUR,'AFTERSALE_EXPIRED','普通售后窗口已结束；安全事故请使用事故报案');
      ensure(!await tx.serviceTicket.findFirst({where:{orderId:id,status:{not:'CLOSED'}}}),'TICKET_EXISTS','已有处理中工单');
      const ticket=await tx.serviceTicket.create({data:{orderId:id,userId:user.id,reason:(incident?'【事故】':'')+reason}});
      await tx.order.update({where:{id},data:{aftersaleStatus:'PROCESSING',feeStatus:'DISPUTED',settlementStatus:o.settlementStatus==='SETTLED'?'SETTLED':'FROZEN'}});
      await this.audit(tx,user.id,'AFTERSALE_OPENED',id,{ticketId:ticket.id});return ticket;
    });
  }
  async review(user:User,id:string,b:Data){
    return this.transaction(async tx=>{
      const o=await this.authorizedOrder(tx,user,id);ensure(o.customerId===user.id&&o.confirmedAt&&o.acceptedChefId,'FORBIDDEN','完成确认后用户可评价',403);
      const age=this.clock().getTime()-o.confirmedAt.getTime(),old=await tx.review.findUnique({where:{orderId:id}});
      if(b.followup){ensure(old&&age<=15*24*HOUR&&!old.followup,'REVIEW_WINDOW','不能重复追评或超过15天');return tx.review.update({where:{orderId:id},data:{followup:text(b.followup,'追评',500)}});}
      ensure(!old&&age<=7*24*HOUR,'REVIEW_WINDOW','不能重复初评或超过7天');
      const row=await tx.review.create({data:{orderId:id,userId:user.id,chefId:o.acceptedChefId,taste:integer(b.taste,'口味',1,5),service:integer(b.service,'服务',1,5),punctuality:integer(b.punctuality,'准时度',1,5),body:text(b.body,'评价',500),anonymous:b.anonymous===true}});
      await tx.order.update({where:{id},data:{reviewStatus:'REVIEWED'}});await this.audit(tx,user.id,'REVIEW_CREATED',id);return row;
    });
  }
  async insurance(user:User,id:string,b:Data){
    ensure(process.env.APP_MODE==='sandbox','INSURANCE_UNAVAILABLE','保险服务尚未开通',503);
    return this.transaction(async tx=>{const o=await this.authorizedOrder(tx,user,id);ensure(o.customerId===user.id,'FORBIDDEN','仅订单用户可报案',403);const policy=await tx.insurancePolicy.update({where:{orderId:id},data:{claimReason:text(b.reason,'报案内容',1000)}});await this.audit(tx,user.id,'SANDBOX_INSURANCE_CLAIM',id);return policy;});
  }
  async dashboard(user:User){
    this.role(user,'OPERATOR','ADMIN','FINANCE','FINANCE_MANAGER','CUSTOMER_SERVICE','REVIEWER','RISK');
    const [orders,chefs,tickets,payments,refunds]=await Promise.all([this.db.order.count(),this.db.chef.count(),this.db.serviceTicket.count({where:{status:{not:'CLOSED'}}}),this.db.ledgerEntry.aggregate({where:{kind:'PAYMENT'},_sum:{amountFen:true}}),this.db.ledgerEntry.aggregate({where:{kind:'REFUND'},_sum:{amountFen:true}})]);
    return {orders,chefs,openTickets:tickets,receivedFen:payments._sum.amountFen??0,refundedFen:-(refunds._sum.amountFen??0),sandbox:process.env.APP_MODE==='sandbox'};
  }
  async opsChefs(user:User){this.role(user,'REVIEWER','OPERATOR','ADMIN');const rows=await this.db.chef.findMany({include:{user:{select:{displayName:true}},packages:true},orderBy:{createdAt:'desc'}});return rows.map(c=>({...c,data:{...obj(c.data),healthAssetId:user.roles.includes('REVIEWER')?obj(c.data).healthAssetId:undefined}}));}
  async auditChef(user:User,id:string,b:Data){
    this.role(user,'REVIEWER');
    return this.transaction(async tx=>{
      const c=await tx.chef.findUnique({where:{id}});ensure(c,'NOT_FOUND','厨师不存在',404);ensure(c.userId!==user.id,'SELF_REVIEW','不可审核本人');
      ensure(['TRIAL','APPROVED','REJECTED','SUSPENDED'].includes(b.status),'INVALID_STATUS','审核状态无效',400);
      if(['TRIAL','APPROVED'].includes(b.status)){ensure(c.healthValidUntil&&c.healthValidUntil>this.clock(),'EXPIRED_HEALTH','健康证已过期');ensure(Array.isArray(b.checks)&&['identity','health','skill','conduct'].every(k=>b.checks.includes(k)),'CHECKS_REQUIRED','四维审核缺项');}
      if(b.status==='APPROVED')ensure(await tx.order.count({where:{acceptedChefId:id,fulfillmentStatus:'COMPLETED'}})>=3,'TRIAL_REQUIRED','需完成前三单试岗');
      const row=await tx.chef.update({where:{id},data:{status:b.status,acceptingOrders:['TRIAL','APPROVED'].includes(b.status),data:{...obj(c.data),reviewReason:text(b.reason,'审核说明',500),reviewedAt:this.clock().toISOString()}}});
      await this.audit(tx,user.id,'CHEF_REVIEWED',id,{status:b.status,reason:b.reason,checks:b.checks??[]});return row;
    });
  }
  async opsTickets(user:User){this.role(user,'CUSTOMER_SERVICE','FINANCE_MANAGER','FINANCE','RISK','ADMIN');return this.db.serviceTicket.findMany({orderBy:{createdAt:'desc'}});}
  async decideTicket(user:User,id:string,b:Data){
    return this.transaction(async tx=>{
      const t=await tx.serviceTicket.findUnique({where:{id}});ensure(t,'NOT_FOUND','工单不存在',404);const o=await tx.order.findUniqueOrThrow({where:{id:t.orderId}});
      if(b.action==='propose'){
        this.role(user,'CUSTOMER_SERVICE');ensure(t.status==='OPEN','INVALID_STATE','工单不可重复建议');
        const refundFen=integer(b.refundFen,'退款金额',0,o.receivedFen-o.refundedFen);
        await tx.serviceTicket.update({where:{id},data:{status:'PROPOSED',refundFen,proposedBy:user.id,decision:text(b.decision,'裁定建议',1000)}});
      }else if(b.action==='approve'){
        this.role(user,'FINANCE_MANAGER');ensure(t.status==='PROPOSED'&&t.proposedBy!==user.id,'SEPARATION_REQUIRED','需要独立审批人');
        await tx.serviceTicket.update({where:{id},data:{status:'APPROVED',approvedBy:user.id}});
      }else if(b.action==='execute'){
        this.role(user,'FINANCE');ensure(t.status==='APPROVED'&&t.approvedBy!==user.id&&t.proposedBy!==user.id,'SEPARATION_REQUIRED','需要独立财务执行人');
        ensure(o.settlementStatus!=='SETTLED','RECOVERY_REQUIRED','已结算退款需追偿渠道，沙箱当前不执行该资金动作');
        await this.refund(tx,o,t.refundFen??0,'ticket:'+id);
        const remaining=o.receivedFen-o.refundedFen-(t.refundFen??0);
        // A financial ruling closes this service with the approved net amount.
        await tx.order.update({where:{id:o.id},data:{contractStatus:o.confirmedAt?'FULFILLED':'CANCELLED',aftersaleStatus:'CLOSED',feeStatus:'SETTLED',fulfillmentStatus:o.confirmedAt?'COMPLETED':'STOPPED',balanceFen:0,settlementStatus:remaining>0?'PENDING':'INELIGIBLE',details:{...obj(o.details),adjudicated:true,adjudicatedNetFen:remaining}}});
        if(remaining===0)await tx.coupon.updateMany({where:{orderId:o.id},data:{status:'AVAILABLE',orderId:null}});
        await tx.bookingLock.deleteMany({where:{orderId:o.id}});await tx.chefOrder.updateMany({where:{orderId:o.id,status:'INVITED'},data:{status:'EXPIRED'}});
        await tx.insurancePolicy.updateMany({where:{orderId:o.id},data:{status:'SANDBOX_CANCELLED'}});
        await tx.serviceTicket.update({where:{id},data:{status:'CLOSED',executedBy:user.id}});
      }else ensure(false,'INVALID_ACTION','工单操作无效',400);
      await this.audit(tx,user.id,'TICKET_'+b.action.toUpperCase(),o.id,{ticketId:id});return tx.serviceTicket.findUnique({where:{id}});
    });
  }
  async settle(user:User,id:string){
    ensure(process.env.APP_MODE==='sandbox','SETTLEMENT_UNAVAILABLE','结算渠道尚未开通',503);
    this.role(user,'FINANCE');
    return this.transaction(async tx=>{
      const o=await tx.order.findUnique({where:{id}});ensure(o,'NOT_FOUND','订单不存在',404);
      if(o.settlementStatus==='SETTLED')return {ok:true};
      ensure(o.settlementStatus==='PENDING'&&o.feeStatus==='SETTLED'&&['NONE','CLOSED'].includes(o.aftersaleStatus)&&o.acceptedChefId,'SETTLEMENT_BLOCKED','订单尚不满足结算条件');
      const d=obj(o.details);ensure(!d.adjudicated,'ALLOCATION_PENDING','部分履约裁定资金分配需另行发布，禁止按普通佣金结算');
      ensure(o.confirmedAt&&o.balanceFen===0,'SETTLEMENT_BLOCKED','需要完成确认且无欠款');
      const net=o.receivedFen-o.refundedFen,commissionFen=Math.round(d.serviceFen*obj(o.ruleSnapshot).commissionRate),subsidyFen=d.discountFen??0,chefFen=net+subsidyFen-commissionFen;
      ensure(chefFen>=0,'NEGATIVE_SETTLEMENT','结算异常');
      await tx.ledgerEntry.create({data:{orderId:id,reference:'settlement:'+id,kind:'SETTLEMENT',amountFen:-chefFen}});
      if(subsidyFen)await tx.ledgerEntry.create({data:{orderId:id,reference:'subsidy:'+id,kind:'PLATFORM_SUBSIDY',amountFen:subsidyFen}});
      await tx.order.update({where:{id},data:{settlementStatus:'SETTLED',details:{...d,settlement:{chefFen,commissionFen,subsidyFen,provider:'sandbox',settledAt:this.clock().toISOString()}}}});
      await this.audit(tx,user.id,'SANDBOX_SETTLED',id,{chefFen,commissionFen,subsidyFen});return {chefFen,commissionFen,subsidyFen,sandbox:process.env.APP_MODE==='sandbox'};
    });
  }
  async publishRules(user:User,b:Data){
    this.role(user,'ADMIN');
    ensure(Number.isFinite(b.commissionRate)&&b.commissionRate>=0&&b.commissionRate<1,'INVALID_RATE','佣金比例无效',400);
    integer(b.matchMinutes,'流拍分钟',1,30);integer(b.radiusM,'服务半径',100,10000);integer(b.urgentMinMinutes,'急单提前分钟',15,120);integer(b.couponFen,'券额',0,100000);integer(b.couponMinFen,'用券门槛',0,1000000);
    ensure(Array.isArray(b.regions)&&b.regions.length>0&&b.regions.every((r:Data)=>typeof r.code==='string'&&typeof r.name==='string'&&typeof r.active==='boolean'),'INVALID_REGIONS','片区配置无效',400);
    const data={commissionRate:b.commissionRate,matchMinutes:b.matchMinutes,radiusM:b.radiusM,urgentMinMinutes:b.urgentMinMinutes,couponFen:b.couponFen,couponMinFen:b.couponMinFen,couponEnabled:b.couponEnabled===true,regions:b.regions,sandbox:process.env.APP_MODE==='sandbox'};
    return this.transaction(async tx=>{const row=await tx.platformRule.create({data:{id:'rules-'+randomUUID(),data,publishedBy:user.id}});await this.audit(tx,user.id,'RULES_PUBLISHED',row.id,{reason:text(b.reason,'变更原因',500)});return row;});
  }
}