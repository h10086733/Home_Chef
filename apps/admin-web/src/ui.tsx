import React,{useState}from'react';import{useQuery}from'@tanstack/react-query';import{Tag,Spin,Alert,Button}from'antd';import{api,labels,upload}from'./api';
export type Run=(fn:()=>Promise<unknown>,success?:string)=>Promise<void>;
export function useData(path:string,enabled=true){return useQuery({queryKey:[path],queryFn:()=>api(path),enabled});}
export const status=(v:string)=><Tag color={['CANCELLED','DISPUTED','FROZEN'].includes(v)?'orange':'green'}>{labels[v]??v}</Tag>;
export const options=(list:string[])=>list.map(value=>({value,label:labels[value]??value}));
export function Field({label,children}:{label:string,children:React.ReactNode}){return <label className="field"><span>{label}</span>{children}</label>;}
export function QueryState({q}:{q:any}){return q.isLoading?<Spin/>:q.error?<Alert type="error" message={q.error.message} action={<Button onClick={()=>q.refetch()}>重试</Button>}/>:null;}
export function UploadField({label,orderId,onUploaded,run}:{label:string,orderId?:string,onUploaded:(id:string)=>void,run:Run}){const[id,setId]=useState('');return <Field label={label+'（PNG/JPEG，≤3MB）'}><input type="file" accept="image/png,image/jpeg" onChange={e=>{const f=e.target.files?.[0];if(f)void run(async()=>{const a=await upload(f,orderId);onUploaded(a.id);setId(a.id);},'凭证上传成功');}}/>{id&&<small className="green">已上传</small>}</Field>;}
