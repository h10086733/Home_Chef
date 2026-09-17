import {test} from 'node:test';
import assert from 'node:assert/strict';
import {logContext,logRecord,logRoute,safeError} from './logging';
test('log fields exclude request bodies, credentials and personal information',()=>{
 const record=logRecord('error','request.failed',{requestId:'req-1',statusCode:500,password:'SECRET',authorization:'Bearer SECRET',body:{address:'SECRET'},rawEvent:'SECRET',openId:'SECRET',apiKey:'SECRET'});
 assert.equal(record.requestId,'req-1');assert.equal(record.statusCode,500);assert(!JSON.stringify(record).includes('SECRET'));
});
test('untrusted paths and query secrets are replaced by route templates',()=>{
 assert.equal(logRoute('/api/orders/private-order-id/wechat-pay?token=SECRET'),'/api/orders/:id/wechat-pay');
 assert(!logRoute('/SECRET/login?password=SECRET').includes('SECRET'));
});
test('errors retain code and call locations without raw error messages',()=>{
 const error=Object.assign(new Error('password=SECRET address=SECRET\\n    at injectedSECRET()'),{code:'P2002'});const safe=safeError(error);
 assert.equal(safe.errorCode,'P2002');assert(!JSON.stringify(safe).includes('SECRET'));assert(safe.frames);
});
test('concurrent request log contexts remain isolated',async()=>{
 const results=await Promise.all(['one','two'].map(requestId=>logContext.run({requestId,userId:requestId},async()=>{await new Promise(r=>setTimeout(r,5));return logRecord('info','completed');})));
 assert.deepEqual(results.map(r=>r.requestId),['one','two']);assert.equal(logContext.getStore(),undefined);
});