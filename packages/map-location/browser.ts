/** Shared by the website and Taro H5. Coordinates are GCJ-02. */
export type MapPoint={name:string;address:string;latitude:number;longitude:number;coordinateSystem:'GCJ02'};
export type MapConfig={enabled:boolean;key?:string;referer?:string};
export function pointFromPicker(data:any):MapPoint|null{
 if(!data||data.module!=='locationPicker'||typeof data.poiname!=='string'||typeof data.poiaddress!=='string')return null;
 const latitude=data.latlng?.lat,longitude=data.latlng?.lng;
 if(typeof latitude!=='number'||typeof longitude!=='number'||!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180||!data.poiname.trim()||!data.poiaddress.trim()||data.poiname.length>120||data.poiaddress.length>200)return null;
 return {name:data.poiname.trim(),address:data.poiaddress.trim(),latitude,longitude,coordinateSystem:'GCJ02'};
}
let active=false;
export function chooseBrowserLocation(config:MapConfig,initial?:MapPoint|null):Promise<MapPoint|null>{
 if(!config.enabled||!config.key||!config.referer)return Promise.reject(new Error('地图尚未配置，请联系管理员启用腾讯地图后再添加地址。'));
 if(active)return Promise.reject(new Error('请先完成当前地图选址。'));
 active=true;
 return new Promise(resolve=>{
  const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;
  const overlay=document.createElement('div');overlay.className='home-chef-map-picker';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','地图选址');
  overlay.style.cssText='position:fixed;inset:0;z-index:10000;background:#15291d88;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;font-family:system-ui,sans-serif;';
  const panel=document.createElement('div');panel.style.cssText='display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;width:760px;max-width:100%;height:85vh;max-height:800px;box-shadow:0 20px 70px #0004;color:#283e33;font-size:16px;';
  const header=document.createElement('div');header.style.cssText='display:flex;align-items:center;justify-content:space-between;padding:14px;gap:12px;';
  const title=document.createElement('strong');title.textContent='搜索小区 / 街道，在地图上选点';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='取消选址';cancel.style.cssText='padding:9px 12px;border:1px solid #d8e0d2;border-radius:8px;background:white;cursor:pointer;flex-shrink:0;';
  const iframe=document.createElement('iframe');iframe.title='腾讯地图选点';iframe.style.cssText='width:100%;flex:1;min-height:180px;border:0;';iframe.allow='geolocation';
  const params=new URLSearchParams({type:'1',search:'1',key:config.key!,referer:config.referer!});
  if(initial)params.set('coord',initial.latitude+','+initial.longitude);
  iframe.src='https://apis.map.qq.com/tools/locpicker?'+params;
  const footer=document.createElement('div');footer.style.cssText='padding:14px;display:flex;flex-direction:column;gap:10px;';
  const summary=document.createElement('div');summary.textContent='请在地图中选择位置；无法定位时，可直接搜索。若加载失败，请检查网络或重试。';summary.style.cssText='font-size:14px;line-height:1.6;';
  const confirm=document.createElement('button');confirm.type='button';confirm.textContent='确认这个位置';confirm.disabled=true;confirm.style.cssText='padding:12px;border:0;border-radius:8px;background:#285741;color:#fff;font-size:16px;cursor:pointer;opacity:.45;';
  let selected:MapPoint|null=null;
  function finish(point:MapPoint|null){window.removeEventListener('message',message);document.removeEventListener('keydown',keyboard);overlay.remove();document.body.style.overflow=overflow;active=false;previous?.focus();resolve(point);}
  function message(event:MessageEvent){
   if(event.origin!=='https://apis.map.qq.com'||event.source!==iframe.contentWindow)return;
   const point=pointFromPicker(event.data);if(!point)return;selected=point;
   summary.textContent=point.name+' · '+point.address;confirm.disabled=false;confirm.style.opacity='1';
  }
  function keyboard(event:KeyboardEvent){
   if(event.key==='Escape'){event.preventDefault();finish(null);}
   if(event.key==='Tab'&&event.shiftKey&&document.activeElement===cancel){event.preventDefault();(confirm.disabled?iframe:confirm).focus();}
   else if(event.key==='Tab'&&!event.shiftKey&&document.activeElement===confirm){event.preventDefault();cancel.focus();}
  }
  cancel.onclick=()=>finish(null);confirm.onclick=()=>{if(selected)finish(selected);};
  header.append(title,cancel);footer.append(summary,confirm);panel.append(header,iframe,footer);overlay.append(panel);
  window.addEventListener('message',message);document.addEventListener('keydown',keyboard);document.body.append(overlay);document.body.style.overflow='hidden';cancel.focus();
 });
}
export function fullMapAddress(point:MapPoint,door:string){
 const base=point.address.includes(point.name)?point.address:point.address+' '+point.name;
 return base+(door.trim()?' '+door.trim():'');
}
