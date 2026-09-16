import { Queue, Worker } from 'bullmq';
async function main() {
  if(process.env.WORKER_ENABLED!=='true'){console.log('Worker disabled; set WORKER_ENABLED=true');return;}
  if(!process.env.INTERNAL_JOB_SECRET)throw new Error('INTERNAL_JOB_SECRET required');
  const url=new URL(process.env.REDIS_URL??'redis://localhost:56379');
  const connection={host:url.hostname,port:Number(url.port),...(url.password?{password:url.password}:{})};
  const queue=new Queue('home-chef-timers',{connection});
  await queue.upsertJobScheduler('tick',{every:5000},{name:'tick',data:{},opts:{attempts:5,backoff:{type:'exponential',delay:1000},removeOnComplete:100,removeOnFail:100}});
  const worker=new Worker('home-chef-timers',async()=>{
    const response=await fetch((process.env.API_URL??'http://127.0.0.1:3000')+'/internal/tick',{method:'POST',headers:{authorization:'Bearer '+process.env.INTERNAL_JOB_SECRET},signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error('Timer API returned '+response.status);
    return response.json();
  },{connection,concurrency:1});
  worker.on('failed',(_,e)=>console.error('Scheduled task failed:',e.message));
  const stop=async()=>{await worker.close();await queue.close();};
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  console.log('BullMQ worker connected; persistent timers enabled');
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
