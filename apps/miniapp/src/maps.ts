import Taro from '@tarojs/taro';
import {api} from './api';
import {chooseBrowserLocation,fullMapAddress,type MapPoint} from '../../../packages/map-location/browser';
export {fullMapAddress};export type {MapPoint};
export async function chooseMapLocation(initial?:MapPoint|null):Promise<MapPoint|null>{
 if(process.env.TARO_ENV==='h5')return chooseBrowserLocation(await api('/maps/config'),initial);
 try{
  const result=await Taro.chooseLocation(initial?{latitude:initial.latitude,longitude:initial.longitude}:{});
  const latitude=Number(result.latitude),longitude=Number(result.longitude);
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180||!result.name||!result.address)throw new Error('地图未返回有效位置，请重新选点。');
  return {name:result.name,address:result.address,latitude,longitude,coordinateSystem:'GCJ02'};
 }catch(e:any){
  const message=String(e.errMsg??e.message??'');
  if(/cancel/i.test(message))return null;
  if(/auth deny|auth denied|authorize|permission|privacy/i.test(message)){
   const modal=await Taro.showModal({title:'需要位置权限',content:'地图选址用于填写服务地址。可在设置中开启位置权限后重试；如仍无法使用，请确认小程序位置与隐私能力已开通。',confirmText:'打开设置'});
   if(modal.confirm)await Taro.openSetting();
   return null;
  }
  throw new Error('地图选址失败，请稍后重试，并确认小程序位置能力已开通。');
 }
}
