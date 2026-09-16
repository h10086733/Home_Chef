import { PrismaClient } from '@prisma/client';
import { hashPassword, encrypt } from '../apps/api/src/security';
const db=new PrismaClient();
async function main(){
  if(process.env.APP_MODE!=='sandbox')throw new Error('Seed requires APP_MODE=sandbox');
  const password=process.env.DEMO_PASSWORD;if(!password)throw new Error('Set DEMO_PASSWORD');
  const specs=[['demo','林女士',['USER']],['chef1','陈师傅',['USER','CHEF']],['chef2','刘师傅',['USER','CHEF']],['chef3','周师傅',['USER','CHEF']],['operator','运营审核',['OPERATOR','REVIEWER','ADMIN']],['support','客服仲裁',['CUSTOMER_SERVICE','RISK']],['manager','财务负责人',['FINANCE_MANAGER']],['finance','财务执行',['FINANCE']]] as const;
  const users:Record<string,any>={};
  for(const [username,displayName,roles]of specs)users[username]=await db.user.upsert({where:{username},update:{},create:{username,displayName,roles:[...roles],passwordHash:hashPassword(password)}});
  await db.platformRule.upsert({where:{id:'sandbox-v1'},update:{},create:{id:'sandbox-v1',publishedBy:users.operator.id,data:{sandbox:true,commissionRate:.15,matchMinutes:10,radiusM:3000,urgentMinMinutes:30,couponFen:2000,couponMinFen:20000,couponEnabled:true,regions:[{code:'CS-YL',name:'长沙 · 岳麓试运营片区',active:true},{code:'CS-TX',name:'长沙 · 天心待开放片区',active:false}]}}});
  await db.address.upsert({where:{id:'demo-address'},update:{},create:{id:'demo-address',userId:users.demo.id,label:'家',regionCode:'CS-YL',latitude:28.194,longitude:112.961,maskedText:'长沙 · 岳麓试运营片区',encryptedText:encrypt('演示地址：岳麓区家庭厨房（虚构，勿实际前往）')}});
  const now=new Date(),from=new Date(now.getTime()-86400000),to=new Date(now.getTime()+32*86400000);
  for(let i=1;i<=3;i++){
    const id='demo-chef-'+i,chef=await db.chef.upsert({where:{id},update:{},create:{id,userId:users['chef'+i].id,status:'TRIAL',healthValidUntil:new Date(now.getTime()+180*86400000),acceptingOrders:true,data:{bio:['十五年湘菜经验，把熟悉的烟火气带回家。','擅长清淡家常菜，让一家老小都吃得舒心。','家宴与时令小炒，用心做好每一桌饭。'][i-1],cuisines:['湘菜','粤菜'],latitude:28.194+i*.001,longitude:112.961+i*.001,regionCode:'CS-YL',rating:5,completed:0,sandboxCertification:true}}});
    await db.servicePackage.upsert({where:{id:'demo-package-'+i},update:{},create:{id:'demo-package-'+i,chefId:chef.id,name:['四菜一汤 · 家常晚餐','六菜一汤 · 团圆家宴','八菜一汤 · 周末宴客'][i-1],description:'含备菜、烹饪、装盘、简单灶台清理与餐具归位；不含洗碗、深度清洁与厨余清运。',serviceFen:[19800,29800,39800][i-1]}});
    await db.scheduleSlot.upsert({where:{id:'demo-slot-'+i},update:{endsAt:to},create:{id:'demo-slot-'+i,chefId:chef.id,startsAt:from,endsAt:to}});
  }
  console.log('Sandbox seed ready: demo / chef1 / chef2 / chef3 / operator / support / manager / finance. Password is DEMO_PASSWORD in .env.');
}
main().finally(()=>db.$disconnect());
