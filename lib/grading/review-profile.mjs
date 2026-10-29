/** Public reviewer configuration only. Credentials must never be put in this object. */
import {getProvider,normalizeUsage} from './providers.mjs';

const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===expected.length&&expected.every(k=>Object.hasOwn(value,k));
export function validateReviewProfile(profile){
  if(!keys(profile,['provider','model','reasoning','outputTokens','pricing']))throw new Error('复核模型配置缺失或含未知字段。');
  getProvider(profile.provider);
  if(typeof profile.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(profile.model))throw new Error('复核模型名称无效。');
  if(!['low','medium','high','xhigh','max'].includes(profile.reasoning)||!Number.isInteger(profile.outputTokens)||profile.outputTokens<1||profile.outputTokens>64000)throw new Error('复核模型推理强度或输出上限无效。');
  const p=profile.pricing;
  if(!keys(p,['input','cachedInput','output','budgetFx','version'])||['input','cachedInput','output','budgetFx'].some(k=>typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<0)||p.output<=0||p.budgetFx<=0||p.cachedInput>p.input||typeof p.version!=='string'||!p.version.trim()||p.version.length>100)throw new Error('复核模型须配置已核对的每百万token费率、预算换算系数和费率版本。');
  return profile;
}
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
export function profilesEqual(a,b){
  try{validateReviewProfile(a);validateReviewProfile(b);return canonical(a)===canonical(b);}catch{return false;}
}
export async function reviewResultHash(result){
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(result))))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function estimateReviewCny(usage,profile){
  try{validateReviewProfile(profile);}catch{return null;}
  const u=normalizeUsage(usage);if(!u)return null;
  const p=profile.pricing,cached=u.input_tokens_details?.cached_tokens??0;
  const cost=((u.input_tokens-cached)*p.input+cached*p.cachedInput+u.output_tokens*p.output)*p.budgetFx/1e6;
  return Number.isFinite(cost)?Math.round(cost*1e8)/1e8:null;
}
