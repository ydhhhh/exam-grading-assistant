/** Local teacher review of a preparation draft; never calls a model or edits its response. */
import {ValidationError,exactKeys,text,validatePack} from './validation.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{throw new ValidationError(message);};
const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const same=(left,right)=>JSON.stringify(stable(left))===JSON.stringify(stable(right));
function messages(value,label){
  if(!Array.isArray(value)||value.length>100||value.some(item=>typeof item!=='string'||!item.trim()||item.length>2000))fail(`${label}格式无效。`);
  return value;
}
export function preparationFeedback(response){
  if(!response||typeof response!=='object'||Array.isArray(response))fail('规则整理结果无效。');
  return {warnings:messages(response.warnings,'待处理问题'),notes:messages(response.notes===undefined?[]:response.notes,'规则说明')};
}
function sourceDraft(attempt){
  if(attempt?.kind!=='prepare'||attempt.state!=='done')fail('只能核对最近一次已完成的规则整理结果。');
  const response=attempt.response,{warnings,notes}=preparationFeedback(response);
  validatePack(response.pack,{draft:true});
  if(response.pack.demo||response.pack.approved_by!=='')fail('模型草案不能自行确认或作为固定演示规则。');
  return {pack:response.pack,warnings,notes};
}
export function validatePreparationReview(attempt){
  const source=sourceDraft(attempt),review=attempt.ruleReview;
  exactKeys(review,['sourcePack','warnings','pack','resolutions','reviewer','changeSummary','reviewedAt'],'规则核对记录');
  if(!same(review.sourcePack,source.pack)||!same(review.warnings,source.warnings))fail('规则核对记录与模型原始草案或待处理问题不一致。');
  validatePack(review.pack,{draft:true});
  if(review.pack.demo||review.pack.approved_by!=='')fail('核对草案仍须在页面确认后才能使用。');
  messages(review.resolutions,'逐项处理说明');
  if(review.resolutions.length!==source.warnings.length)fail('请逐项填写每个待处理问题的核对依据或补充说明。');
  text(review.reviewer,'核对人',200);
  text(review.changeSummary,'规则修订说明',2000,same(review.pack,source.pack));
  if(typeof review.reviewedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(review.reviewedAt)||!Number.isFinite(Date.parse(review.reviewedAt))||new Date(review.reviewedAt).toISOString()!==review.reviewedAt)fail('规则核对时间无效。');
  return review;
}
export function reviewPreparationDraft(attempts,{pack,resolutions,reviewer,changeSummary=''}={}){
  if(!Array.isArray(attempts)||!attempts.length)fail('没有可核对的规则整理结果。');
  const attempt=attempts.at(-1),source=sourceDraft(attempt);
  const next={...attempt,ruleReview:{sourcePack:clone(source.pack),warnings:clone(source.warnings),pack:clone(pack),resolutions:clone(resolutions),reviewer,changeSummary,reviewedAt:new Date().toISOString()}};
  validatePreparationReview(next);
  return [...attempts.slice(0,-1).map(clone),clone(next)];
}
