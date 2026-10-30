/** Authenticated server entry point. Browser code imports api-core instead. */
import {handleAPI} from './api-core.mjs';
import {resolveRuntime,isAuthenticated,runtimeFailure} from './server-runtime.mjs';
export * from './api-core.mjs';

/** Every public route uses this wrapper; an absent production configuration fails closed. */
export async function handleRuntimeAPI(request,action,fetcher=fetch,runtime=resolveRuntime()){
  const stage=action==='identity'?'grade':action;
  const expectedProfile=runtime.stageProfiles?.[stage];
  const provider=runtime.mode==='managed'?expectedProfile?.provider:request.headers.get('x-api-provider')||expectedProfile?.provider;
  const reject=(code,message,status=401)=>runtimeFailure(code,message,status,{provider,...(expectedProfile?{stageProfile:expectedProfile}:{}),...(action==='review'?{reviewProfile:expectedProfile}:{})});
  if(!runtime.ready)return reject('CONFIGURATION',runtime.message||'评分服务尚未配置完成。',503);
  if(runtime.mode==='managed'){
    if(!await isAuthenticated(request,runtime))return reject('SESSION_REQUIRED','请先使用负责人提供的访问口令登录。');
    if(request.headers.get('x-api-key'))return reject('MANAGED_KEY','正式模式使用负责人配置的服务，请清除测试密钥。',400);
    if(expectedProfile&&request.headers.has('x-api-provider')&&request.headers.get('x-api-provider')!==expectedProfile.provider)return reject('PROVIDER_CHANGED','服务端阶段模型与本批次不一致，请核对后开启新批次。',409);
  }
  return handleAPI(request,action,fetcher,runtime);
}
