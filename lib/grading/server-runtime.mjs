/** Server-only environment and staff sessions. Never import this module from a client component. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {getProvider} from './providers.mjs';
import {validateReviewProfile} from './review-profile.mjs';
import {BoundedInputError,readBoundedInput} from './bounded-input.mjs';

const environments=new AsyncLocalStorage();
export const runWithGradingEnvironment=(env,run)=>environments.run(env,run);
const COOKIE='grading_session',SESSION_SECONDS=8*60*60;
const validKey=key=>typeof key==='string'&&key.length>=20&&key.length<=512&&!/\s/.test(key);
const validSecret=(value,min)=>typeof value==='string'&&value.length>=min&&value.length<=512;
export function resolveRuntime(env=environments.getStore()||{}){
  const mode=env.GRADING_MODE==='test'?'test':env.GRADING_MODE==='managed'?'managed':'unconfigured';
  const runtime={mode,provider:'openai',ready:false,reviewProfile:null,message:'请负责人在服务端配置评分服务。'};
  if(mode==='unconfigured')return runtime;
  try{
    runtime.provider=getProvider(env.GRADING_PROVIDER||'openai').id;
    if(env.GRADING_REVIEW_PROFILE){
      const profile=JSON.parse(env.GRADING_REVIEW_PROFILE);validateReviewProfile(profile);
      if(profile.provider===runtime.provider&&profile.model===getProvider(runtime.provider).model)throw new Error('same model');
      runtime.reviewProfile=profile;
    }
    if(mode==='test'){runtime.ready=true;runtime.message='测试模式：密钥只在当前页面使用。';return runtime;}
    if(!validKey(env.GRADING_API_KEY)||!validSecret(env.GRADING_ACCESS_CODE,16)||!validSecret(env.GRADING_SESSION_SECRET,32))throw new Error('missing credentials');
    const reviewerKey=runtime.reviewProfile?(env.GRADING_REVIEW_API_KEY||(runtime.reviewProfile.provider===runtime.provider?env.GRADING_API_KEY:'')):'';
    if(runtime.reviewProfile&&!validKey(reviewerKey))throw new Error('missing review key');
    return {...runtime,ready:true,message:'评分服务由负责人统一配置。',apiKey:env.GRADING_API_KEY,reviewApiKey:reviewerKey,accessCode:env.GRADING_ACCESS_CODE,sessionSecret:env.GRADING_SESSION_SECRET};
  }catch{
    return {...runtime,ready:false,reviewProfile:null,message:'服务端配置未完成或格式无效，请负责人检查服务商、密钥、访问口令和复核费率。'};
  }
}
export function runtimeResponse(body,status=200,extraHeaders={}){
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store, max-age=0','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...extraHeaders}});
}
export const runtimeFailure=(code,error,status=401,metadata={})=>runtimeResponse({...metadata,code,error,uncertain:false,estimatedCny:0,notSent:true},status);
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
  const cookie=request.headers.get('cookie')||'';
  if(cookie.length>8192)return false;
  const token=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if(!token||token.length>250)return false;
  const [expiry,nonce,signature,...extra]=token.split('.');
  if(extra.length||!/^\d{10}$/.test(expiry)||!/^[-A-Za-z0-9_]{20,80}$/.test(nonce)||!/^[-A-Za-z0-9_]{43}$/.test(signature))return false;
  const seconds=Math.floor(now/1000);
  if(Number(expiry)<=seconds||Number(expiry)>seconds+SESSION_SECONDS)return false;
  // Bind sessions to the origin and current access code; rotating either secret revokes existing sessions.
  return equalSecret(signature,await mac(runtime.sessionSecret,`${new URL(request.url).origin}|${runtime.accessCode}|${expiry}.${nonce}`));
}
export async function handleRuntimeConfig(request,runtime=resolveRuntime()){
  const {mode,provider,ready,reviewProfile,message}=runtime;
  return runtimeResponse({mode,provider,ready,reviewProfile,message,authenticated:await isAuthenticated(request,runtime)});
}
let loginWindow=0,loginAttempts=0;
export async function handleSession(request,runtime=resolveRuntime(),now=Date.now()){
  if(request.method!=='POST'&&request.method!=='DELETE')return runtimeFailure('METHOD','此接口只接受登录或退出。',405);
  if(request.headers.get('origin')!==new URL(request.url).origin)return runtimeFailure('ORIGIN','请从本站页面登录。',403);
  const cookieOptions=`Path=/; HttpOnly; SameSite=Strict${new URL(request.url).protocol==='https:'?'; Secure':''}`;
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
  const signature=await mac(runtime.sessionSecret,`${new URL(request.url).origin}|${runtime.accessCode}|${unsigned}`);
  return runtimeResponse({authenticated:true},200,{'set-cookie':`${COOKIE}=${unsigned}.${signature}; Max-Age=${SESSION_SECONDS}; ${cookieOptions}`});
}
