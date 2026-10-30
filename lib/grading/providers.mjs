/** Fixed domestic API origins. A user-supplied address can never receive a key. */
const standard=Object.freeze({reasoning:'high',outputTokens:8000});
const grade=Object.freeze({reasoning:'max',outputTokens:16000});
const models=items=>Object.freeze(items.map(([id,label])=>Object.freeze({id,label})));
export const PROVIDERS=Object.freeze({
  kimi:Object.freeze({id:'kimi',label:'Kimi',model:'kimi-k3.1-pro',models:models([['kimi-k3.1-pro','Kimi K3.1 Pro']]),protocol:'chat',requests:Object.freeze({grade,identity:standard,prepare:standard}),endpoint:'https://api.moonshot.cn/v1/chat/completions',pricingUrl:'https://platform.kimi.com/'}),
  deepseek:Object.freeze({id:'deepseek',label:'DeepSeek',model:'deepseek-flash',models:models([['deepseek-flash','DeepSeek Flash']]),protocol:'responses',requests:Object.freeze({grade,identity:standard,prepare:standard}),endpoint:'https://api.deepseek.com/responses',pricingUrl:'https://api-docs.deepseek.com/quick_start/pricing/'}),
  qwen:Object.freeze({id:'qwen',label:'Qwen',model:'qwen3.8-max',models:models([['qwen3.8-max','Qwen3.8 Max'],['qwen3.8-flash','Qwen3.8 Flash']]),protocol:'chat',requests:Object.freeze({grade,identity:standard,prepare:standard}),endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',pricingUrl:'https://help.aliyun.com/en/model-studio/qwen3-8-max'}),
});
export function getProvider(id){
  if(typeof id!=='string'||!Object.hasOwn(PROVIDERS,id))throw new Error('请选择 Kimi、DeepSeek 或 Qwen；不能使用其他服务商或自定义地址。');
  return PROVIDERS[id];
}
export function getRequestSettings(id,action='grade'){
  const {requests}=getProvider(id);if(action==='review')action='grade';
  if(typeof action!=='string'||!Object.hasOwn(requests,action))throw new Error('未知请求操作。');
  return requests[action];
}
// Official price snapshot, 2026-10-30. CNY per million tokens except DeepSeek's
// existing USD peak-rate ceiling; never assume a cache hit or an off-peak rate.
export const MODEL_PRICING=Object.freeze({
  'kimi-k3.1-pro':Object.freeze({input:13,cachedInput:1.3,output:68,budgetFx:1,version:'2026-10-30-CNY-5m-cache'}),
  'deepseek-flash':Object.freeze({input:.3,cachedInput:.006,output:1.2,budgetFx:7.5,version:'2026-10-30-USD-peak-ceiling'}),
  'qwen3.8-max':Object.freeze({input:12,cachedInput:1.5,output:36,budgetFx:1,version:'2026-10-30-CNY-Beijing'}),
  'qwen3.8-flash':Object.freeze({input:.8,cachedInput:.1,output:2.7,budgetFx:1,version:'2026-10-30-CNY-Beijing'}),
});
export const PRICING=Object.freeze({version:'2026-10-30',budgetFx:7.5,deepseek:Object.freeze({...MODEL_PRICING['deepseek-flash'],basis:'peak-rate-ceiling'})});
export function getDefaultProfile(provider,action='grade',model=getProvider(provider).model){
  const p=getProvider(provider);if(!p.models.some(m=>m.id===model))throw new Error('模型不在该服务商的已核实列表中。');
  return {provider,model,...getRequestSettings(provider,action),pricing:{...MODEL_PRICING[model]}};
}
export const DEFAULT_STAGE_PROFILES=Object.freeze({
  prepare:Object.freeze(getDefaultProfile('kimi','prepare')),
  grade:Object.freeze(getDefaultProfile('deepseek','grade')),
  review:Object.freeze(getDefaultProfile('kimi','review')),
});
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===expected.length&&expected.every(k=>Object.hasOwn(value,k));
export function validateStageProfile(profile){
  if(!keys(profile,['provider','model','reasoning','outputTokens','pricing']))throw new Error('阶段模型配置缺失或含未知字段。');
  const provider=getProvider(profile.provider);
  if(!provider.models.some(m=>m.id===profile.model))throw new Error('请选择该服务商已核实的视觉模型。');
  const efforts=profile.provider==='kimi'?['low','high','max']:profile.provider==='qwen'?['low','medium','high','xhigh','max']:['low','medium','high','max'];
  if(!efforts.includes(profile.reasoning)||!Number.isInteger(profile.outputTokens)||profile.outputTokens<1||profile.outputTokens>64000)throw new Error('模型推理强度或输出上限无效。');
  const p=profile.pricing;
  if(!keys(p,['input','cachedInput','output','budgetFx','version'])||['input','cachedInput','output','budgetFx'].some(k=>typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<0)||p.output<=0||p.input<=0||p.budgetFx<=0||p.cachedInput>p.input||typeof p.version!=='string'||!p.version.trim()||p.version.length>100)throw new Error('阶段模型须包含有效费率、预算换算系数及费率版本。');
  return profile;
}
export function validateStageProfiles(profiles){
  if(!keys(profiles,['prepare','grade','review']))throw new Error('必须分别配置规则整理、识别与初评、独立复核三个步骤。');
  for(const p of Object.values(profiles))validateStageProfile(p);
  if(profiles.grade.provider===profiles.review.provider&&profiles.grade.model===profiles.review.model)throw new Error('独立复核必须选择与初评不同的模型。');
  return profiles;
}
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
export function stageProfilesEqual(a,b){try{validateStageProfiles(a);validateStageProfiles(b);return canonical(a)===canonical(b);}catch{return false;}}
const count=n=>Number.isSafeInteger(n)&&n>=0;
export function normalizeUsage(usage){
  if(!usage||!count(usage.input_tokens)||!count(usage.output_tokens))return null;
  const normalized={input_tokens:usage.input_tokens,output_tokens:usage.output_tokens};
  if(usage.input_tokens_details!==undefined){
    const details=usage.input_tokens_details;
    if(!details||typeof details!=='object'||Array.isArray(details))return null;
    if(details.cached_tokens!==undefined){
      if(!count(details.cached_tokens)||details.cached_tokens>usage.input_tokens)return null;
      normalized.input_tokens_details={cached_tokens:details.cached_tokens};
    }
  }
  return normalized;
}
export function normalizeProviderUsage(usage,protocol){
  if(protocol!=='chat')return normalizeUsage(usage);
  if(!usage||typeof usage!=='object'||Array.isArray(usage))return null;
  if(usage.prompt_tokens_details!==undefined&&(!usage.prompt_tokens_details||typeof usage.prompt_tokens_details!=='object'||Array.isArray(usage.prompt_tokens_details)))return null;
  const cached=usage.prompt_tokens_details?.cached_tokens??usage.prompt_cache_hit_tokens;
  return normalizeUsage({input_tokens:usage.prompt_tokens,output_tokens:usage.completion_tokens,...(cached===undefined?{}:{input_tokens_details:{cached_tokens:cached}})});
}
export function estimateProfileCny(usage,profile){
  try{validateStageProfile(profile);}catch{return null;}
  const u=normalizeUsage(usage);if(!u)return null;
  const p=profile.pricing,cached=u.input_tokens_details?.cached_tokens??0;
  const cost=((u.input_tokens-cached)*p.input+cached*p.cachedInput+u.output_tokens*p.output)*p.budgetFx/1e6;
  return Number.isFinite(cost)?Math.round(cost*1e8)/1e8:null;
}
export function estimateProviderCny(usage,provider='deepseek'){
  try{return estimateProfileCny(usage,getDefaultProfile(provider));}catch{return null;}
}
export function pricingMetadata(provider,usage){
  const profile=getDefaultProfile(provider);
  return {...profile.pricing,provider,basis:provider==='deepseek'?'peak-rate-ceiling':'official-rate-snapshot',cacheUsage:usage?.input_tokens_details?.cached_tokens===undefined?'uncached-ceiling':'reported'};
}
