import {PrismaClient} from '@prisma/client';
import {hashPassword} from '../apps/api/src/security';
const db=new PrismaClient();
async function main(){
 if(process.env.APP_MODE!=='business')throw new Error('Business bootstrap requires APP_MODE=business');
 const username=process.env.ADMIN_BOOTSTRAP_USERNAME??'operator',password=process.env.ADMIN_BOOTSTRAP_PASSWORD;
 if(!password||password.length<16)throw new Error('Set ADMIN_BOOTSTRAP_PASSWORD (16+ characters)');
 const admin=await db.user.upsert({where:{username},update:{},create:{username,displayName:'平台管理员',passwordHash:hashPassword(password),roles:['USER','ADMIN','OPERATOR','REVIEWER']}});
 if(!await db.platformRule.count())await db.platformRule.create({data:{id:'business-v1',publishedBy:admin.id,data:{commissionRate:.15,matchMinutes:10,radiusM:3000,urgentMinMinutes:30,couponFen:2000,couponMinFen:20000,couponEnabled:false,regions:[{code:'CS-YL',name:'长沙市岳麓区',active:true},{code:'CS-TX',name:'长沙市天心区',active:false}]}}});
 console.log('Business database initialized: operational administrator and service rules only; no sample customers, chefs, addresses or orders.');
}
main().finally(()=>db.$disconnect());
