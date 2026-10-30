/** Public build settings only. Never import server runtime or credentials here. */
import {DEFAULT_STAGE_PROFILES} from './providers.mjs';

export const DEPLOYMENT_TARGET=process.env.NEXT_PUBLIC_DEPLOYMENT_TARGET||'node';
export const IS_GITHUB_PAGES=DEPLOYMENT_TARGET==='github-pages';
export const BASE_PATH=(process.env.NEXT_PUBLIC_BASE_PATH||'').replace(/\/$/,'');
export function publicPath(path,basePath=BASE_PATH){
  if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//'))throw Error('本站资源路径无效。');
  if(basePath&&!/^\/(?:[A-Za-z0-9_-]+\/?)+$/.test(basePath))throw Error('网站部署路径无效。');
  return basePath.replace(/\/$/,'')+path;
}
export function storageName(name,target=DEPLOYMENT_TARGET,basePath=BASE_PATH){
  return target==='github-pages'?name+'-pages:'+basePath:name;
}
export function browserRuntimeConfig(){
  const stageProfiles=structuredClone(DEFAULT_STAGE_PROFILES);
  return {mode:'test',ready:true,stageProfiles,reviewProfile:stageProfiles.review,provider:stageProfiles.grade.provider,authenticated:false,browserDirect:true};
}
export const MANAGED_BACKUP_NOTICE='这份备份来自负责人统一服务，可在此查看、人工确认和导出；继续调用模型请先备份，再开启个人密钥模式的新批次。';
export function assertDeploymentCanRun(job,target=DEPLOYMENT_TARGET){
  if(target==='github-pages'&&!job.demo&&job.settings.credentialMode==='managed')throw Error(MANAGED_BACKUP_NOTICE);
}
/** Pages has no local API server. Only the four grading actions reach the adapter. */
export function createDeploymentFetch({target=DEPLOYMENT_TARGET,fetcher,loadBrowserAPI=()=>import('./browser-api.mjs')}={}){
  return async(path,options={})=>{
    if(target!=='github-pages')return (fetcher||globalThis.fetch)(path,options);
    if(path==='/api/runtime-config'&&(options.method||'GET').toUpperCase()==='GET')return Response.json(browserRuntimeConfig());
    if(path==='/api/session')return Response.json({error:'本网页使用个人密钥，无需访问码登录。'},{status:404});
    const {browserAPIFetch}=await loadBrowserAPI();
    return browserAPIFetch(path,options);
  };
}
export const deploymentFetch=createDeploymentFetch();
