/** Server-only environment and staff sessions. Never import this module from a client component. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {DEFAULT_STAGE_PROFILES,validateStageProfiles} from './providers.mjs';
import {BoundedInputError,readBoundedInput} from './bounded-input.mjs';
import {normalizePublicOrigin,requestOrigin,isSameOriginRequest,runtimeResponse,runtimeFailure} from './runtime-http.mjs';
export {normalizePublicOrigin,requestOrigin,isSameOriginRequest,runtimeResponse,runtimeFailure} from './runtime-http.mjs';

const environments=new AsyncLocalStorage();
export const runWithGradingEnvironment=(env,run)=>environments.run(env,run);
const COOKIE='grading_session',SESSION_SECONDS=8*60*60;
const validKey=key=>typeof key==='string'&&key.length>=20&&key.length<=512&&!/\s/.test(key);
const validSecret=(value,min)=>typeof value==='string'&&value.length>=min&&value.length<=512;
export function resolveRuntime(env=environments.getStore()||(typeof process!=='undefined'?process.env:{})){
  const mode=env.GRADING_MODE==='test'?'test':env.GRADING_MODE==='managed'?'managed':'unconfigured';
  const runtime={mode,provider:'deepseek',ready:false,stageProfiles:structuredClone(DEFAULT_STAGE_PROFILES),reviewProfile:structuredClone(DEFAULT_STAGE_PROFILES.review),message:'请负责人在服务端配置评分服务。'};
  try{runtime.publicOrigin=normalizePublicOrigin(env.GRADING_PUBLIC_ORIGIN);}catch{return {...runtime,originInvalid:true,message:'公开访问地址配置无效，请检查 GRADING_PUBLIC_ORIGIN。'};}
  if(mode==='unconfigured')return runtime;
  try{
    const candidate=env.GRADING_STAGE_PROFILES?JSON.parse(env.GRADING_STAGE_PROFILES):structuredClone(DEFAULT_STAGE_PROFILES);
    validateStageProfiles(candidate);
    runtime.stageProfiles=candidate;
    runtime.provider=runtime.stageProfiles.grade.provider;runtime.reviewProfile=runtime.stageProfiles.review;
    if(mode==='test'){runtime.ready=true;runtime.message='三个步骤分别填写自己的密钥，仅在当前页面内存使用。';return runtime;}
    const stageKeys={prepare:env.GRADING_PREPARE_API_KEY||'',grade:env.GRADING_API_KEY||'',review:env.GRADING_REVIEW_API_KEY||''};
    if(Object.values(stageKeys).some(key=>!validKey(key))||!validSecret(env.GRADING_ACCESS_CODE,16)||!validSecret(env.GRADING_SESSION_SECRET,32))throw new Error('missing credentials');
    return {...runtime,ready:true,message:'三个步骤的 API 由负责人统一配置。',stageKeys,apiKey:stageKeys.grade,reviewApiKey:stageKeys.review,accessCode:env.GRADING_ACCESS_CODE,sessionSecret:env.GRADING_SESSION_SECRET};
  }catch{
    return {...runtime,ready:false,message:'服务端配置未完成或格式无效，请检查三个步骤的模型、密钥、费率及访问口令。'};
  }
}
const bytes=value=>new TextEncoder().encode(value);
const base64=value=>btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
async function mac(secret,value){
  const key=await crypto.subtle.importKey('raw',bytes(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return base64(await crypto.subtle.sign('HMAC',key,bytes(value)));
}
async function equalSecret(a,b){
  const [x,y]=await Promise.all([crypto.subtle.digest('SHA-256',bytes(a)),crypto.subtle.digest('SHA-256',bytes(b))]);
  const aa=new Uint8Array(x),bb=new Uint8Array(y);let result=0;for(let i=0;i<aa.length;i++)result|=aa[i]^bb[i];return result===0;
}
export async function isAuthenticated(request,runtime,now=Date.now()){
  if(runtime.mode!=='managed'||!runtime.ready)return false;
  const origin=requestOrigin(request,runtime);if(!origin)return false;
  const cookie=request.headers.get('cookie')||'';
  if(cookie.length>8192)return false;
  const token=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!token||token.length>250)return false;
  const [expiry,nonce,signature,...extra]=token.split('.');
  if(extra.length||!/^\d{10}$/.test(expiry)||!/^[-A-Za-z0-9_]{20,80}$/.test(nonce)||!/^[-A-Za-z0-9_]{43}$/.test(signature))return false;
  const seconds=Math.floor(now/1000);
  if(Number(expiry)<=seconds||Number(expiry)>seconds+SESSION_SECONDS)return false;
  // Bind sessions to the origin and current access code; rotating either secret revokes existing sessions.
  return equalSecret(signature,await mac(runtime.sessionSecret,`${origin}|${runtime.accessCode}|${expiry}.${nonce}`));
}
export async function handleRuntimeConfig(request,runtime=resolveRuntime()){
  const {mode,provider,ready,reviewProfile,stageProfiles,message}=runtime;
  return runtimeResponse({mode,provider,ready,reviewProfile,stageProfiles,message,authenticated:await isAuthenticated(request,runtime)});
}
let loginWindow=0,loginAttempts=0;
export async function handleSession(request,runtime=resolveRuntime(),now=Date.now()){
  if(request.method!=='POST'&&request.method!=='DELETE')return runtimeFailure('METHOD','此接口只接受登录或退出。',405);
  if(!isSameOriginRequest(request,runtime))return runtimeFailure('ORIGIN','请从本站页面登录。',403);
  const origin=requestOrigin(request,runtime);
  const cookieOptions=`Path=/; HttpOnly; SameSite=Strict${origin.startsWith('https:')?'; Secure':''}`;
  if(request.method==='DELETE')return runtimeResponse({authenticated:false},200,{'set-cookie':`${COOKIE}=; Max-Age=0; ${cookieOptions}`});
  if(runtime.mode!=='managed'||!runtime.ready)return runtimeFailure('CONFIGURATION','统一评分服务尚未配置完成。',503);
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return runtimeFailure('CONTENT_TYPE','提交内容格式不正确。',415);
  // Bounded per-isolate throttle complements deployment-level rate limiting; no IPs or credentials are stored.
  if(now-loginWindow>=60000){loginWindow=now;loginAttempts=0;}
  if(++loginAttempts>20)return runtimeFailure('LOGIN_LIMIT','尝试次数较多，请稍后再登录。',429);
  let body;
  try{
    body=JSON.parse(await readBoundedInput(request,{maximum:2048,timeoutMs:10000,label:'访问验证'}));
  }catch(error){
    if(error instanceof BoundedInputError)return runtimeFailure(error.code,error.message,error.status);
    return runtimeFailure('ACCESS_CODE','访问口令无效。',400);
  }
  if(!body||Object.keys(body).length!==1||typeof body.accessCode!=='string'||body.accessCode.length>512||!await equalSecret(body.accessCode,runtime.accessCode))return runtimeFailure('ACCESS_CODE','访问口令不正确。',401);
  const expiry=Math.floor(now/1000)+SESSION_SECONDS,nonce=base64(crypto.getRandomValues(new Uint8Array(24))),unsigned=`${expiry}.${nonce}`;
  const signature=await mac(runtime.sessionSecret,`${origin}|${runtime.accessCode}|${unsigned}`);
  return runtimeResponse({authenticated:true},200,{'set-cookie':`${COOKIE}=${unsigned}.${signature}; Max-Age=${SESSION_SECONDS}; ${cookieOptions}`});
}
