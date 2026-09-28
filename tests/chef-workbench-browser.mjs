import {chromium} from 'playwright';
import {readdir,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
const d=(await readdir(homedir()+'/.cache/ms-playwright')).filter(x=>/^chromium-/.test(x)).sort().reverse()[0];
const b=await chromium.launch({headless:true,executablePath:homedir()+'/.cache/ms-playwright/'+d+'/chrome-linux64/chrome'});
try{
 for(const width of [1280,390]){
 const p=await b.newPage({viewport:{width,height:1000}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname.replace('/api','');
  let body=[];
  if(path==='/me')body={id:'fixture-user',displayName:'界面测试厨师',roles:['USER','CHEF']};
  if(path==='/runtime')body={mode:'business',paymentEnabled:false};
  if(path==='/rules')body={regions:[{code:'CS-YL',name:'长沙市岳麓区',active:true}]};
  if(path==='/chef/profile')body={id:'fixture-chef',status:'REJECTED',healthValidUntil:'2027-01-01T00:00:00Z',data:{bio:'已保存的家常菜介绍',cuisines:['湘菜'],regionCode:'CS-YL',latitude:28.181,longitude:112.946,healthAssetId:'fixture-asset',reviewReason:'请补充清晰材料'},packages:[],schedules:[]};
  if(path==='/files')body={id:'fixture-new-asset'};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await p.addInitScript(()=>localStorage.setItem('home-chef-token','fixture-only'));
 await p.goto('http://127.0.0.1:5173');await p.getByRole('button',{name:'厨师工作台',exact:true}).click();
 const bio=p.locator('.field').filter({hasText:'自我介绍'}).locator('textarea');
 await p.getByText('已保存的接单出发位置',{exact:true}).waitFor();assert.equal(await bio.inputValue(),'已保存的家常菜介绍');
 assert.equal(await p.locator('input[type=date]').inputValue(),'2027-01-01');
 assert(await p.getByRole('button',{name:'提交审核',exact:true}).isDisabled());
 assert.equal(await p.getByRole('button',{name:'新增套餐',exact:true}).count(),0);
 assert.equal(await p.getByRole('button',{name:'添加档期',exact:true}).count(),0);
 await bio.fill('用户正在修改的介绍');await p.getByRole('checkbox',{name:'已阅读服务边界，同意审核与前三单试岗'}).check();
 assert(await p.getByRole('button',{name:'提交审核',exact:true}).isEnabled());
 await p.locator('input[type=file]').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
 await p.getByText('已上传',{exact:true}).waitFor();assert.equal(await bio.inputValue(),'用户正在修改的介绍');
 await p.locator('.busy').waitFor({state:'hidden'});assert(await p.getByRole('checkbox',{name:'已阅读服务边界，同意审核与前三单试岗'}).isChecked());assert(await p.getByRole('button',{name:'提交审核',exact:true}).isEnabled());await p.evaluate(()=>scrollTo(0,0));
 const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false,'horizontal overflow');
 await mkdir('.data/workbench-ui',{recursive:true});await p.screenshot({path:'.data/workbench-ui/'+width+'.png',fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS '+width+': prefill, consent, review guards, upload preserves edits, no horizontal overflow');await p.close();
 }
}finally{await b.close()}
