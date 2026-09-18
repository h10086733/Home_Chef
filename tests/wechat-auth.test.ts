import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {Service} from '../apps/api/src/service';
import {WechatIdentity,wechatPhoneLogin} from '../apps/api/src/wechat-auth';
import {decrypt} from '../apps/api/src/security';
assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/home_chef_test_wechat');
process.env.WECHAT_LOGIN_ENABLED='true';process.env.WECHAT_PAY_ENABLED='false';
const db=new PrismaClient(),svc=new Service(db),appId='wx1234567890abcdef',tag=randomUUID();after(()=>db.$disconnect());
let openId='openid-'+tag,phone='199'+String(randomInt(10000000,99999999)),watermark=appId,phoneError=0,tokens=0;
const used=new Set<string>();
const transport:typeof fetch=async(input,init)=>{const u=new URL(String(input));assert.equal(u.hostname,'api.weixin.qq.com');let result:any;
 if(u.pathname==='/sns/jscode2session'){assert(u.searchParams.get('js_code'));result={openid:openId,session_key:'PRIVATE_SESSION'};}
 else if(u.pathname==='/cgi-bin/stable_token'){tokens++;assert.equal(JSON.parse(String(init?.body)).appid,appId);result={access_token:'PRIVATE_TOKEN',expires_in:7200};}
 else{assert.equal(u.pathname,'/wxa/business/getuserphonenumber');const code=JSON.parse(String(init?.body)).code;result=used.has(code)||phoneError?{errcode:phoneError||40029}:{errcode:0,phone_info:{purePhoneNumber:phone,countryCode:'86',watermark:{appid:watermark}}};used.add(code);}
 return new Response(JSON.stringify(result));};
const wx=new WechatIdentity(appId,'PRIVATE_SECRET',transport),body=()=>({loginCode:randomUUID(),phoneCode:randomUUID(),consent:true});
test('WeChat phone login and UID binding',async t=>{
 let uid:string,firstPhone:string;
 await t.test('consent required, real provider enabled independently from payments',async()=>{await assert.rejects(()=>wechatPhoneLogin(svc,wx,{...body(),consent:false}));assert.equal(await db.user.count({where:{openId}}),0);});
 await t.test('first login creates normal UID, encrypts phone and returns no sensitive identity',async()=>{const r=await wechatPhoneLogin(svc,wx,{...body(),uid:'forged',phone:'forged',roles:['ADMIN']});uid=r.user.id;firstPhone=phone;assert.deepEqual(r.user.roles,['USER']);assert.equal(r.user.phoneBound,true);assert.equal((await svc.session(r.token)).id,uid);const row=await db.user.findUniqueOrThrow({where:{id:uid}});assert.equal(decrypt(row.phoneEncrypted!),'+86'+phone);assert.notEqual(row.phone,phone);assert(!JSON.stringify(r).includes(phone));assert(!JSON.stringify(r).includes(openId));});
 await t.test('concurrent return logins preserve UID and reuse access token',async()=>{const results=await Promise.all([wechatPhoneLogin(svc,wx,body()),wechatPhoneLogin(svc,wx,body())]);assert(results.every(r=>r.user.id===uid));assert.equal(tokens,1);});
 await t.test('reused code and wrong app watermark cannot authenticate',async()=>{const b=body();await wechatPhoneLogin(svc,wx,b);await assert.rejects(()=>wechatPhoneLogin(svc,wx,b));watermark='wx0000000000000000';await assert.rejects(()=>wechatPhoneLogin(svc,wx,body()));watermark=appId;});
 await t.test('phone collision does not merge accounts; different phone cannot silently replace binding',async()=>{openId='other-'+tag;await assert.rejects(()=>wechatPhoneLogin(svc,wx,body()),/其他账号/);assert.equal(await db.user.count({where:{openId}}),0);openId='openid-'+tag;phone='188'+String(randomInt(10000000,99999999));await assert.rejects(()=>wechatPhoneLogin(svc,wx,body()),/换绑/);phone=firstPhone;});
 await t.test('authenticated old account binding keeps its UID and roles',async()=>{openId='legacy-'+tag;phone='177'+String(randomInt(10000000,99999999));const old=await db.user.create({data:{username:'old'+tag.replaceAll('-','').slice(0,12),roles:['USER','CHEF']}});const r=await wechatPhoneLogin(svc,wx,body(),old);assert.equal(r.user.id,old.id);assert.deepEqual(r.user.roles,old.roles);const stranger=await db.user.create({data:{roles:['USER']}});await assert.rejects(()=>wechatPhoneLogin(svc,wx,body(),stranger),/其他账号/);});
 await t.test('provider rejection creates no user or session',async()=>{openId='denied-'+tag;phoneError=40029;await assert.rejects(()=>wechatPhoneLogin(svc,wx,body()));assert.equal(await db.user.count({where:{openId}}),0);phoneError=0;});
});