import {log,logContext,safeError} from '@home-chef/infrastructure';
import { Queue, Worker } from 'bullmq';
async function main() {
  if(process.env.WORKER_ENABLED!=='true'){log('warn','worker.disabled',{service:'worker'});return;}
  if(!process.env.INTERNAL_JOB_SECRET)throw new Error('INTERNAL_JOB_SECRET required');
  const url=new URL(process.env.REDIS_URL??'redis://localhost:56379');
  const connection={host:url.hostname,port:Number(url.port),...(url.password?{password:url.password}:{})};
  const queue=new Queue('home-chef-timers',{connection});
  queue.on('error',e=>log('error','worker.queue.failed',{service:'worker',...safeError(e)}));
  await queue.upsertJobScheduler('tick',{every:5000},{name:'tick',data:{},opts:{attempts:5,backoff:{type:'exponential',delay:1000},removeOnComplete:100,removeOnFail:100}});
  const worker=new Worker('home-chef-timers',async job=>logContext.run({service:'worker',jobId:job.id,attempt:job.attemptsMade+1},async()=>{
    const started=performance.now();
    const response=await fetch((process.env.API_URL??'http://127.0.0.1:3000')+'/internal/tick',{method:'POST',headers:{authorization:'Bearer '+process.env.INTERNAL_JOB_SECRET},signal:AbortSignal.timeout(60000)});
    if(!response.ok){log('error','worker.tick.failed',{requestId:response.headers.get('x-request-id')??undefined,statusCode:response.status,durationMs:Math.round(performance.now()-started)});throw new Error('Timer API failed');}
    const result=await response.json();log('info','worker.tick.completed',{requestId:response.headers.get('x-request-id')??undefined,durationMs:Math.round(performance.now()-started),...result as Record<string,unknown>});return result;
  }),{connection,concurrency:1});
  worker.on('failed',(job,e)=>log('error','worker.job.failed',{service:'worker',jobId:job?.id,attempt:job?.attemptsMade,...safeError(e)}));
  worker.on('error',e=>log('error','worker.connection.failed',{service:'worker',...safeError(e)}));

  const stop=async()=>{await worker.close();await queue.close();};
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  log('info','worker.started',{service:'worker'});
}
void main().catch(e=>{log('error','worker.start_failed',{service:'worker',...safeError(e)});process.exitCode=1;});
