import {spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
process.loadEnvFile(process.env.RELEASE_ENV_FILE??'.env');
const url=new URL(process.env.DATABASE_URL),container=process.env.BACKUP_CONTAINER;
const database=decodeURIComponent(url.pathname.slice(1)),user=decodeURIComponent(url.username);
if(!/^home_chef_[a-zA-Z0-9_]+$/.test(database))throw new Error('仅支持明确命名的 home_chef_* 数据库');
if(container&&(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='55432'))throw new Error('容器备份模式仅支持本机 55432 数据库；远程数据库请安装 PostgreSQL 16 客户端并使用原生模式');
const env={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:user,PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:database};
if(url.searchParams.get('sslmode'))env.PGSSLMODE=url.searchParams.get('sslmode');
const run=(bin,args,stdio)=>{const r=spawnSync(container?'docker':bin,container?['exec','-i',container,bin,...args]:args,{env,stdio});if(r.error||r.status!==0)throw new Error(`${bin} 失败；备份未标记完成`);};
const directory=resolve(process.env.BACKUP_DIR??'.data/backups');mkdirSync(directory,{recursive:true,mode:0o700});
const stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex');
const path=resolve(directory,database+'-'+stamp+'.dump'),partial=path+'.partial',fd=openSync(partial,'wx',0o600);
try{run('pg_dump',['-U',user,'-d',database,'--format=custom','--no-owner','--no-acl'],['ignore',fd,'ignore']);}finally{closeSync(fd);}
const input=openSync(partial,'r');try{run('pg_restore',['--list'],[input,'ignore','ignore']);}finally{closeSync(input);}
renameSync(partial,path);
console.log('备份完成：'+path);
if(process.argv.includes('--verify-restore')){
 const target='home_chef_restorecheck_'+Date.now()+'_'+randomBytes(4).toString('hex');let created=false;
 try{run('createdb',['-U',user,'--maintenance-db=postgres',target],['ignore','ignore','ignore']);created=true;
  const input=openSync(path,'r');try{run('pg_restore',['-U',user,'--dbname='+target,'--no-owner','--no-acl','--exit-on-error'],[input,'ignore','ignore']);}finally{closeSync(input);}
  run('psql',['-U',user,'-d',target,'-v','ON_ERROR_STOP=1','-c','SELECT count(*) FROM "User"; SELECT count(*) FROM "Order"; SELECT count(*) FROM "ChefWalletEntry";'],['ignore','ignore','ignore']);
  writeFileSync(path+'.verified.json',JSON.stringify({verifiedAt:new Date().toISOString(),method:'restore into isolated database; query core and wallet tables'},null,2)+'\n',{mode:0o600});
  console.log('独立数据库恢复演练通过；未覆盖原库。');
 }finally{if(created)run('dropdb',['-U',user,'--maintenance-db=postgres',target],['ignore','ignore','ignore']);}
}
console.log('请将备份复制到受控的异地存储，并单独保管 DATA_KEY；本脚本不导出密钥、不删除历史备份。');