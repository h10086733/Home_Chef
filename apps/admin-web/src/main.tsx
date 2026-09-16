import {Finance,FinanceAccess} from './finance';
import {chooseBrowserLocation,type MapPoint} from '../../../packages/map-location/browser';
import {FoodArt} from './art';
import React,{useState,useEffect}from'react';
import{createRoot}from'react-dom/client';
import{QueryClient,QueryClientProvider,useQueryClient}from'@tanstack/react-query';
import{ConfigProvider,Button,Input,Tag,Spin,message}from'antd';
import{api,type Row}from'./api';import{Field,type Run}from'./ui';
import{Discover,Addresses,Wallet,Chef}from'./customer';import{Orders}from'./orders';import{Dashboard,ChefAudit,Tickets,Ledger,Rules}from'./operations';
import'./style.css';
const qc=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function App(){
 const[user,setUser]=useState<Row|null>(null),[ready,setReady]=useState(false),[tab,setTab]=useState('home'),[busy,setBusy]=useState(false),[login,setLogin]=useState({username:'',password:'',displayName:''}),[register,setRegister]=useState(false);
 const queryClient=useQueryClient();
 const[location,setLocation]=useState<MapPoint|null>(()=>JSON.parse(localStorage.getItem('home-chef-location')??'null')),[confirmation,setConfirmation]=useState('');
 const locate=()=>run(async()=>{const point=await chooseBrowserLocation(await api('/maps/config'),location);if(point){localStorage.setItem('home-chef-location',JSON.stringify(point));setLocation(point);window.dispatchEvent(new Event('service-location-changed'));}},'位置已更新');
 useEffect(()=>{const expired=()=>{setUser(null);queryClient.clear();};window.addEventListener('session-expired',expired);if(localStorage.getItem('home-chef-token'))api('/me').then(setUser).catch(()=>{}).finally(()=>setReady(true));else setReady(true);return()=>window.removeEventListener('session-expired',expired);},[]);
 const run:Run=async(fn,success='操作成功')=>{setBusy(true);try{await fn();message.success(success);await queryClient.invalidateQueries();}catch(e:any){message.error(e.message);}finally{setBusy(false);}};
 const signIn=()=>run(async()=>{if(register&&confirmation!==login.password)throw new Error('两次密码不一致');const data=await api(register?'/auth/register':'/auth/login',login);localStorage.setItem('home-chef-token',data.token);setUser(data.user);},'登录成功');
 const staff=user?.roles.some((r:string)=>['ADMIN','OPERATOR','REVIEWER','FINANCE','FINANCE_MANAGER','CUSTOMER_SERVICE','RISK'].includes(r));
 if(!ready)return <div className="loading"><Spin size="large"/></div>;
 if(!user)return <div className="login"><div className="login-art"><div className="brand">厨临门 <small>HOME CHEF</small></div><span className="eyebrow">长沙 · 家庭私厨</span><h1>好好吃饭，<br/>就从今晚开始。</h1><p>把时间留给家人，把厨房交给专业的人。</p><div className="plate"><FoodArt/></div><div className="promise">认证厨师　 ·　 明码报价　 ·　 用心到家</div></div><div className="login-panel"><span className="eyebrow">欢迎来到厨临门</span><h2>{register?'注册账号':'登录你的账号'}</h2><p className="muted">注册账号，保存地址，查找附近的家常饭服务。</p><Field label="账号"><Input aria-label="账号" value={login.username} onChange={e=>setLogin({...login,username:e.target.value})}/></Field>{register&&<Field label="昵称"><Input value={login.displayName} onChange={e=>setLogin({...login,displayName:e.target.value})}/></Field>}<Field label="密码"><Input.Password aria-label="密码" value={login.password} onChange={e=>setLogin({...login,password:e.target.value})} onPressEnter={()=>void signIn()}/></Field>{register&&<Field label="确认密码"><Input.Password aria-label="确认密码" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></Field>}<Button type="primary" block size="large" loading={busy} onClick={()=>void signIn()}>{register?'注册并登录':'登录'}</Button><Button type="link" onClick={()=>setRegister(!register)}>{register?'已有账号，去登录':'注册新用户'}</Button></div></div>;
 const nav=staff?[['ops','工作概览'],['orders','订单管理'],...(user.roles.some((r:string)=>['REVIEWER','OPERATOR','ADMIN'].includes(r))?[['audit','厨师审核']]:[]),...(user.roles.some((r:string)=>['CUSTOMER_SERVICE','FINANCE','FINANCE_MANAGER','RISK','ADMIN'].includes(r))?[['tickets','售后工单']]:[]),...(user.roles.some((r:string)=>['FINANCE','FINANCE_MANAGER'].includes(r))?[['ledger','财务流水'],['finance','结算提现']]:[]),...(user.roles.includes('ADMIN')?[['rules','运营规则'],['finance-access','财务权限']]:[])]:[['home','发现私厨'],['orders','我的订单'],['addresses','服务地址'],['wallet','优惠与消息'],['chef','厨师工作台']];
 return <><header><div className="brand"><button className="location-button" onClick={()=>void locate()}>位置：{location?.name??'选择服务位置'} ▾</button><small>厨临门 · 家常饭到家</small></div><nav>{nav.map(([key,label])=><button key={key} className={(tab===key||(tab==='home'&&staff&&key==='ops'))?'active':''} onClick={()=>setTab(key)}>{label}</button>)}</nav><div className="identity"><span>{user.displayName}</span><Button size="small" onClick={()=>void run(async()=>{await api('/auth/logout',{});localStorage.removeItem('home-chef-token');setUser(null);queryClient.clear();setTab('home');setRegister(false);setLogin({username:'',password:'',displayName:''});setConfirmation('');},'已退出')}>退出</Button></div></header><main><div className="location">{location?.name??'请选择上门服务位置'} <span>烹饪与基础归位，不含洗碗和深度清洁</span></div>{busy&&<div className="busy"><Spin/> 正在处理</div>}
 {!staff&&tab==='home'&&<Discover run={run} onOrders={()=>setTab('orders')}/>}
 {staff&&(tab==='home'||tab==='ops')&&<Dashboard/>}
 {tab==='orders'&&<Orders user={user} run={run} staff={staff}/>}
 {tab==='addresses'&&<Addresses run={run}/>}
 {tab==='wallet'&&<Wallet run={run}/>}
 {tab==='chef'&&<Chef run={run}/>}
 {tab==='audit'&&<ChefAudit run={run}/>}
 {tab==='tickets'&&<Tickets user={user} run={run}/>}
 {tab==='ledger'&&<Ledger/>}
 {tab==='finance'&&<Finance user={user} run={run}/>} 
 {tab==='finance-access'&&<FinanceAccess run={run}/>}
 {tab==='rules'&&<Rules run={run}/>}
 </main><footer>厨临门 HOME CHEF · 长沙本地上门私厨<br/><small>家常手艺，认真服务每一餐</small></footer></>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={qc}><ConfigProvider button={{autoInsertSpace:false}} theme={{token:{colorPrimary:'#244b38',borderRadius:10,fontFamily:'Inter, PingFang SC, Microsoft YaHei, sans-serif'}}}><App/></ConfigProvider></QueryClientProvider></React.StrictMode>);