/** Only these official origins may receive a user's key. Never accept a URL from a request. */
import {MODEL} from './validation.mjs';
const OPENAI_REQUEST=Object.freeze({reasoning:'medium',outputTokens:8000});
const DEEPSEEK_STANDARD_REQUEST=Object.freeze({reasoning:'high',outputTokens:8000});
export const PROVIDERS=Object.freeze({
  openai:Object.freeze({id:'openai',label:'OpenAI',model:MODEL,requests:Object.freeze({grade:OPENAI_REQUEST,identity:OPENAI_REQUEST,prepare:OPENAI_REQUEST}),endpoint:'https://api.openai.com/v1/responses',pricingUrl:'https://developers.openai.com/api/docs/models/gpt-6.1-terra'}),
  deepseek:Object.freeze({id:'deepseek',label:'DeepSeek',model:'deepseek-flash',requests:Object.freeze({grade:Object.freeze({reasoning:'max',outputTokens:16000}),identity:DEEPSEEK_STANDARD_REQUEST,prepare:DEEPSEEK_STANDARD_REQUEST}),endpoint:'https://api.deepseek.com/responses',pricingUrl:'https://api-docs.deepseek.com/quick_start/pricing/'}),
});
export function getProvider(id){
  if(typeof id!=='string'||!Object.hasOwn(PROVIDERS,id))throw new Error('请选择 OpenAI 或 DeepSeek；不能使用自定义服务地址。');
  return PROVIDERS[id];
}
export function getRequestSettings(id,action='grade'){
  const {requests}=getProvider(id);
  if(typeof action!=='string'||!Object.hasOwn(requests,action))throw new Error('未知请求操作。');
  return requests[action];
}

// USD / million tokens, checked 2026-10-29 against the linked official pages.
// DeepSeek always uses peak rates as a conservative budget estimate: calendar,
// holidays and request completion time must never make us under-reserve a batch.
export const PRICING=Object.freeze({
  version:'2026-10-29',budgetFx:7.5,
  deepseek:Object.freeze({input:0.3,cachedInput:0.006,output:1.2,basis:'peak-rate-ceiling'}),
});
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
export function estimateProviderCny(usage,provider='openai'){
  const u=normalizeUsage(usage);if(!u)return null;
  let usd;
  if(provider==='deepseek'){
    const cached=u.input_tokens_details?.cached_tokens??0,rates=PRICING.deepseek;
    usd=(u.input_tokens-cached)*rates.input+cached*rates.cachedInput+u.output_tokens*rates.output;
  }else if(provider==='openai'){
    const long=u.input_tokens>272000;
    usd=u.input_tokens*(long?2:1)+u.output_tokens*(long?7.5:5);
  }else return null;
  return Math.round(usd*PRICING.budgetFx/1e6*1e8)/1e8;
}
export function pricingMetadata(provider,usage){
  return {provider,version:PRICING.version,budgetFx:PRICING.budgetFx,basis:provider==='deepseek'?PRICING.deepseek.basis:'standard-rate-estimate',cacheUsage:usage?.input_tokens_details?.cached_tokens===undefined?'uncached-ceiling':'reported'};
}
