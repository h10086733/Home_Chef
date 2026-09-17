import {randomUUID} from 'node:crypto';
import {log,logContext,logRoute,safeError} from '@home-chef/infrastructure';
import 'reflect-metadata';
import { Get, Post, Delete, Controller, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { ChefFinanceService } from './chef-finance';
import { ApiError, ensure } from './errors';




const db = new PrismaClient();
let service:ChefFinanceService;
const attempts=new Map<string,{count:number,until:number}>();
@Controller()
class ApiController {
  @Post('*') post(@Req() req:any,@Res() res:any) { return this.route(req,res); }
  @Delete('*') remove(@Req() req:any,@Res() res:any) { return this.route(req,res); }
  @Get('*')
  async route(@Req() req:any,@Res() res:any) {
    const path=new URL(req.url,'http://localhost').pathname.replace(/^\/api/,'');
    const parts=path.split('/').filter(Boolean),method=req.method,b=req.body??{};
    try{
      if(method==='GET'&&path==='/health'){await db.$queryRaw`SELECT 1`;return res.send({status:'ok',service:'home-chef',sandbox:process.env.APP_MODE==='sandbox'});}
      if(method==='POST'&&['/auth/login','/auth/register'].includes(path)){
        const ip=req.ip,now=Date.now();if(attempts.size>10000)for(const[k,v]of attempts)if(v.until<now)attempts.delete(k);
        const v=attempts.get(ip);if(v&&v.until>now){ensure(v.count<30,'RATE_LIMIT','登录尝试过多，请15分钟后重试',429);v.count++;}else attempts.set(ip,{count:1,until:now+900000});
        return res.send(await service.login(b,path==='/auth/register'));
      }
      if(path==='/chef/transfers/notify'&&method==='POST'){ensure(Buffer.isBuffer(req.rawBody),'INVALID_BODY','缺少通知原文',400);await service.transferNotification(req.headers,req.rawBody.toString('utf8'));return res.status(204).send();}
      if(path==='/payments/wechat/notify'&&method==='POST'){
        ensure(Buffer.isBuffer(req.rawBody),'INVALID_BODY','缺少通知原文',400);
        await service.paymentNotification(req.headers,req.rawBody.toString('utf8'));return res.status(204).send();
      }
      if(path==='/internal/tick'&&method==='POST'){ensure(process.env.INTERNAL_JOB_SECRET&&req.headers.authorization==='Bearer '+process.env.INTERNAL_JOB_SECRET,'FORBIDDEN','无权执行任务',403);return res.send(await service.tick());}
      const token=String(req.headers.authorization??'').replace(/^Bearer /,'');
      const user=await service.session(token);const context=logContext.getStore();if(context)context.userId=user.id;
      let result:unknown;
      if(path==='/runtime'&&method==='GET')result={mode:process.env.APP_MODE,paymentEnabled:!!service.wx,paymentChannel:'WECHAT_MINIPROGRAM',insuranceEnabled:process.env.APP_MODE==='sandbox',couponsEnabled:(await service.rules(db)).couponEnabled};
      else if(path==='/auth/wechat/bind'&&method==='POST')result=await service.bindWechat(user,b.code);
      else if(parts[0]==='orders'&&parts.length===3&&parts[2]==='wechat-pay'&&method==='POST')result=await service.prepay(user,parts[1],b.paymentChoice,b.changeId);
      else if(parts[0]==='payments'&&parts.length===3&&parts[2]==='status'&&method==='POST')result=await service.paymentStatus(user,parts[1]);
      else if(path==='/chef/wallet'&&method==='GET')result=await service.wallet(user);
      else if(path==='/chef/payout-profile'&&method==='POST')result=await service.payoutProfile(user,b);
      else if(path==='/chef/withdrawals'&&method==='POST')result=await service.withdraw(user,b);
      else if(parts[0]==='chef'&&parts[1]==='withdrawals'&&parts[2]&&method==='POST')result=parts[3]==='status'?await service.withdrawalStatus(user,parts[2]):await service.withdrawalAction(user,parts[2],b);
      else if(path==='/ops/finance-roles'&&['GET','POST'].includes(method))result=await service.financeRoles(user,method==='POST'?b:undefined);
      else if(path==='/ops/finance'&&method==='GET')result=await service.financeOverview(user);
      else if(parts[0]==='ops'&&parts[1]==='withdrawals'&&parts[2]&&method==='POST')result=await service.withdrawalAction(user,parts[2],b);
      else if(parts[0]==='ops'&&parts[1]==='finance'&&parts[2]&&parts[3]&&method==='POST')result=await service.reconcileFinance(user,parts[2],parts[3]);
      else if(path==='/maps/config'&&method==='GET'){const key=process.env.TENCENT_MAP_BROWSER_KEY?.trim(),referer=process.env.TENCENT_MAP_REFERER?.trim();result=key&&referer?{enabled:true,key,referer,coordinateSystem:'GCJ02'}:{enabled:false,coordinateSystem:'GCJ02'};}
      else if(path==='/me'&&method==='GET')result=service.publicUser(user);
      else if(path==='/auth/logout'&&method==='POST')result=await service.logout(token);
      else if(path==='/rules'&&method==='GET')result=await service.rules(db);
      else if(path==='/addresses')result=method==='GET'?await service.addresses(user):method==='POST'?await service.address(user,b):undefined;
      else if(parts[0]==='addresses'&&parts[1]&&method==='DELETE')result=await service.deleteAddress(user,parts[1]);
      else if(path==='/chefs'&&method==='GET')result=await service.chefs(req.query);
      else if(parts[0]==='chefs'&&parts[2]==='reviews'&&method==='GET')result=await db.review.findMany({where:{chefId:parts[1],hidden:false},select:{taste:true,service:true,punctuality:true,body:true,followup:true,createdAt:true},take:50});
      else if(path==='/chef/profile')result=method==='GET'?await service.chefProfile(user):method==='POST'?await service.applyChef(user,b):undefined;
      else if(path==='/chef/packages'&&method==='POST')result=await service.savePackage(user,b);
      else if(path==='/chef/schedules'&&method==='POST')result=await service.saveSchedule(user,b);
      else if(path==='/favorites'&&method==='GET')result=await service.favorites(user);
      else if(parts[0]==='favorites'&&parts[1]&&method==='POST')result=await service.favorites(user,parts[1]);
      else if(path==='/coupons'&&['GET','POST'].includes(method))result=await service.coupons(user,method==='POST');
      else if(path==='/quotes'&&method==='POST')result=await service.quote(user,b);
      else if(parts[0]==='quotes'&&parts[2]==='submit'&&method==='POST')result=await service.submitQuote(user,parts[1]);
      else if(parts[0]==='quotes'&&parts[2]==='pay'&&method==='POST')result=await service.payQuote(user,parts[1],b);
      else if(parts[0]==='quotes'&&parts[2]==='cancel'&&method==='POST')result=await service.cancelQuote(user,parts[1]);
      else if(path==='/orders'&&method==='GET')result=await service.orders(user);
      else if(parts[0]==='orders'&&parts[1]){
        const id=parts[1],action=parts[2];
        if(!action&&method==='GET')result=await service.getOrder(user,id);
        else if(action==='messages'&&['GET','POST'].includes(method))result=await service.messages(user,id,method==='POST'?b:undefined);
        else if(method==='POST'){
          if(action==='changes')result=await service.change(user,id,b);
          else if(action==='accept')result=await service.accept(user,id);
          else if(action==='cancel')result=await service.cancel(user,id,b);
          else if(action==='fulfill')result=await service.fulfill(user,id,b);
          else if(['confirm','confirm-fees','balance','address-consent'].includes(action))result=await service.customerAction(user,id,action,b);
          else if(action==='tickets')result=await service.ticket(user,id,b);
          else if(action==='reviews')result=await service.review(user,id,b);
          else if(action==='insurance-claim')result=await service.insurance(user,id,b);
        }
      }
      else if(path==='/notifications'&&method==='GET')result=await db.notification.findMany({where:{userId:user.id},orderBy:{createdAt:'desc'},take:100});
      else if(parts[0]==='notifications'&&parts[1]&&method==='POST'){await db.notification.updateMany({where:{id:parts[1],userId:user.id},data:{readAt:new Date()}});result={ok:true};}
      else if(path==='/files'&&method==='POST')result=await service.upload(user,b);
      else if(parts[0]==='files'&&parts[1]&&method==='GET'){const f=await service.file(user,parts[1]);return res.header('content-type',f.mime).header('cache-control','no-store').header('x-content-type-options','nosniff').send(Buffer.from(f.bytes));}
      else if(parts[0]==='ops'){
        if(path==='/ops/dashboard'&&method==='GET')result=await service.dashboard(user);
        else if(path==='/ops/chefs'&&method==='GET')result=await service.opsChefs(user);
        else if(parts[1]==='chefs'&&parts[2]&&method==='POST')result=await service.auditChef(user,parts[2],b);
        else if(path==='/ops/tickets'&&method==='GET')result=await service.opsTickets(user);
        else if(parts[1]==='tickets'&&parts[2]&&method==='POST')result=await service.decideTicket(user,parts[2],b);
        else if(parts[1]==='settlements'&&parts[2]&&method==='POST')result=await service.settle(user,parts[2]);
        else if(path==='/ops/rules'&&method==='POST')result=await service.publishRules(user,b);
        else if(path==='/ops/audit'&&method==='GET'){service.role(user,'ADMIN');result=await db.auditEvent.findMany({orderBy:{createdAt:'desc'},take:100});}
        else if(path==='/ops/ledger'&&method==='GET'){service.role(user,'FINANCE','FINANCE_MANAGER');result=await db.ledgerEntry.findMany({orderBy:{createdAt:'desc'},take:500});}
      }
      if(result===undefined)throw new ApiError(404,'NOT_FOUND','接口不存在');
      return res.header('cache-control','no-store').send(result);
    }catch(e:any){
      const err=e instanceof ApiError?e:new ApiError(500,'INTERNAL_ERROR','服务暂时不可用');
      log(err.status>=500?'error':'warn','api.request.failed',{service:'api',requestId:req.id,method:req.method,route:logRoute(path),statusCode:err.status,...safeError(e)});
      return res.status(err.status).send({error:{code:err.code,message:err.message,requestId:req.id}});
    }
  }
}
@Module({controllers:[ApiController]})class AppModule{}
async function main(){
  service=new ChefFinanceService(db);
  if(!['sandbox','business'].includes(process.env.APP_MODE??''))throw new Error('APP_MODE must be business or sandbox.');
  if(process.env.NODE_ENV==='production'&&process.env.APP_MODE==='sandbox')throw new Error('Simulated payments are not allowed in production.');
  if(!/^[a-f0-9]{64}$/i.test(process.env.DATA_KEY??''))throw new Error('Set a 32-byte DATA_KEY (64 hex characters).');
  const app=await NestFactory.create<NestFastifyApplication>(AppModule,new FastifyAdapter({bodyLimit:4500000,trustProxy:process.env.TRUST_LOCAL_PROXY==='true'?['127.0.0.1','::1']:false}),{rawBody:true,logger:false});
  const server=app.getHttpAdapter().getInstance();
  server.addHook('onRequest',(req:any,res:any,done:any)=>{req.startedAt=performance.now();req.id=randomUUID();res.header('x-request-id',req.id);logContext.run({service:'api',requestId:req.id},done);});
  server.addHook('onResponse',(req:any,res:any,done:any)=>{log(res.statusCode>=500?'error':res.statusCode>=400?'warn':'info','http.completed',{service:'api',requestId:req.id,method:req.method,route:logRoute(req.url),statusCode:res.statusCode,durationMs:Math.round(performance.now()-req.startedAt)});done();});
  server.addHook('onError',(req:any,_res:any,error:any,done:any)=>{log('error','http.framework_error',{service:'api',requestId:req.id,...safeError(error)});done();});
  app.enableCors({origin:process.env.WEB_ORIGIN??'http://localhost:5173',methods:['GET','POST','DELETE'],allowedHeaders:['content-type','authorization']});
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT??3000),process.env.HOST??'127.0.0.1');

  const stop=async()=>{await app.close();await db.$disconnect();};
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
}
void main().catch(e=>{log('error','api.start_failed',{service:'api',...safeError(e)});process.exitCode=1;});