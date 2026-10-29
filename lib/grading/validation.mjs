/** Shared deterministic validation. Never calls a model or accesses storage. */
export const VERSION = 'grading-web-2.0.0';
export const MODEL = 'gpt-6.1-terra';
// Shared browser/server limits; they are application safeguards, not provider quotas.
export const RESOURCE_LIMITS = Object.freeze({fileBytes:3*1024*1024,filesBytes:6*1024*1024,requestBytes:10*1024*1024,responseBytes:2*1024*1024,inFlightPerInstance:4});
export const FLAG_CODES = ['UNREADABLE','INPUT_INCOMPLETE','QUESTION_MAPPING_UNCERTAIN','BLANK_UNCERTAIN','TRANSCRIPTION_CONFLICT','ALTERNATIVE_NOT_COVERED','RUBRIC_AMBIGUOUS','MATHEMATICAL_DISPUTE','MULTIPLE_ANSWERS_UNRESOLVED'];

export class ValidationError extends Error {
  constructor(message) { super(message); this.name='ValidationError'; }
}
const fail = message => { throw new ValidationError(message); };
export function exactKeys(value, expected, label='数据') {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==expected.length || !expected.every(k=>Object.hasOwn(value,k))) fail(`${label}字段缺失或包含未知字段。`);
}
export function identifier(value, label='编号') {
  if (typeof value!=='string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value) || ['__proto__','constructor','prototype'].includes(value)) fail(`${label}仅允许安全的英文字母、数字、下划线、连字符。`);
  return value;
}
export function text(value,label='内容',max=100000,allowEmpty=false) {
  if (typeof value!=='string' || value.length>max || (!allowEmpty && !value.trim())) fail(`${label}为空、过长或类型不正确。`);
  return value;
}
function score(value,label='分数') {
  if (typeof value!=='number' || !Number.isFinite(value) || value<0 || value>100000 || Math.abs(value*10000-Math.round(value*10000))>1e-7) fail(`${label}必须为非负有限数，最多四位小数。`);
  return value;
}
export function sumScores(values) {
  return values.reduce((sum,v)=>sum+Math.round(score(v)*10000),0)/10000;
}
export function validateQuestion(q) {
  exactKeys(q,['question_id','text','solution','max_score','criteria'],'题目');
  identifier(q.question_id,'题号');text(q.text,'试题');text(q.solution,'参考答案');score(q.max_score,'题目满分');
  if (!q.max_score || !Array.isArray(q.criteria) || !q.criteria.length || q.criteria.length>100) fail('题目满分与评分点不能为空。');
  const ids=new Set();let maxima=[];
  for (const c of q.criteria) {
    exactKeys(c,['criterion_id','description','allowed_scores','requires'],'评分点');identifier(c.criterion_id,'评分点编号');text(c.description,'评分点说明');
    if (ids.has(c.criterion_id)) fail('评分点编号重复。');ids.add(c.criterion_id);
    if (!Array.isArray(c.allowed_scores) || !c.allowed_scores.length || c.allowed_scores.length>200) fail('必须明确评分点的允许分值。');
    c.allowed_scores.forEach(v=>score(v,'允许分值'));
    if (!c.allowed_scores.includes(0) || new Set(c.allowed_scores).size!==c.allowed_scores.length) fail('允许分值必须包含零且不能重复。');
    maxima.push(Math.max(...c.allowed_scores));
    if (!Array.isArray(c.requires) || c.requires.some(v=>typeof v!=='string') || new Set(c.requires).size!==c.requires.length) fail('评分依赖列表无效。');
  }
  if (sumScores(maxima)!==q.max_score) fail('各评分点满分之和与题目满分不同。');
  const graph=new Map(q.criteria.map(c=>[c.criterion_id,c.requires]));const seen=new Set(),active=new Set();
  function visit(cid) {
    if (!graph.has(cid)) fail('评分依赖引用未知评分点。');
    if (active.has(cid)) fail('评分依赖存在循环。');
    if(seen.has(cid))return;active.add(cid);graph.get(cid).forEach(visit);active.delete(cid);seen.add(cid);
  }
  ids.forEach(visit);return q;
}
export function validatePack(pack,{draft=false}={}) {
  exactKeys(pack,['exam_id','title','version','demo','approved_by','policies','questions'],'考试规则');
  identifier(pack.exam_id,'考试编号');text(pack.title,'考试名称',500);text(pack.version,'规则版本',100);
  if(typeof pack.demo!=='boolean')fail('演示标记无效。');
  text(pack.approved_by,'规则确认人',200,draft);text(pack.policies,'评分政策');
  if(!Array.isArray(pack.questions)||!pack.questions.length||pack.questions.length>100)fail('考试必须包含1至100道题目。');
  const qids=new Set();
  for(const q of pack.questions){validateQuestion(q);if(qids.has(q.question_id))fail('题号重复。');qids.add(q.question_id);}
  if(JSON.stringify(pack).length>500000)fail('考试规则过长。');
  return pack;
}
export function validateScores(scores,question,{nullable=false}={}) {
  validateQuestion(question);
  exactKeys(scores,question.criteria.map(c=>c.criterion_id),'逐点评分');
  for(const c of question.criteria){
    const value=scores[c.criterion_id];if(nullable&&value===null)continue;
    score(value);if(!c.allowed_scores.includes(value))fail('得分不在该评分点允许的档位内。');
    if(value>0&&c.requires.some(dep=>scores[dep]===null||scores[dep]<=0))fail('得分不满足教师设置的前置依赖。');
  }
  return scores;
}
export function validateResult(result,question,pageIds) {
  validateQuestion(question);
  exactKeys(result,['question_id','status','criteria','flags','alternative_solution'],'评分结果');
  if(result.question_id!==question.question_id)fail('返回题号与当前题目不一致。');
  if(!['scored','needs_review'].includes(result.status)||typeof result.alternative_solution!=='boolean')fail('评分状态无效。');
  const evidence=new Set(pageIds);
  function refs(values){if(!Array.isArray(values)||values.some(v=>typeof v!=='string'||!evidence.has(v))||new Set(values).size!==values.length)fail('证据引用不存在、重复或属于其他题目。');}
  if(!Array.isArray(result.criteria)||result.criteria.length!==question.criteria.length)fail('评分点未完整覆盖。');
  const scores=Object.create(null);
  for(const c of result.criteria){
    exactKeys(c,['criterion_id','awarded','evidence_refs','reason'],'评分点结果');identifier(c.criterion_id,'评分点编号');
    if(Object.hasOwn(scores,c.criterion_id))fail('评分点重复返回。');scores[c.criterion_id]=c.awarded;
    text(c.reason,'AI评分理由',10000);refs(c.evidence_refs);
    if(c.awarded!==null&&!c.evidence_refs.length)fail('确定分数（含零分）必须引用原始作答证据。');
  }
  validateScores(scores,question,{nullable:true});
  if(!Array.isArray(result.flags)||result.flags.length>100)fail('异常列表无效。');
  for(const f of result.flags){exactKeys(f,['code','detail','evidence_refs'],'异常标记');if(!FLAG_CODES.includes(f.code))fail('未知异常代码。');text(f.detail,'异常说明',10000);refs(f.evidence_refs);}
  if(result.status==='scored'&&(Object.values(scores).some(v=>v===null)||result.flags.length))fail('未决分数或内容异常不能标记为已评分。');
  if(result.flags.some(f=>f.code==='ALTERNATIVE_NOT_COVERED')&&!result.alternative_solution)fail('替代解法状态不一致。');
  return result;
}
export function advice(task) {
  const unresolved=flags=>({scores:null,total:null,source:'unresolved',flags});
  if(!task.inputComplete)return unresolved(['INPUT_BLOCKED']);
  if(task.review){
    validateScores(task.review.scores,task.question);text(task.review.reviewer,'审阅人',200);text(task.review.reason,'改判理由',10000,true);
    return {scores:task.review.scores,total:sumScores(Object.values(task.review.scores)),source:'human',flags:[]};
  }
  const result=task.result,ids=(task.pages||[]).map(p=>p.page_id);
  if(!result)return unresolved(['RESULT_PENDING']);
  try{validateResult(result,task.question,ids);}catch{return unresolved(['RESULT_INVALID']);}
  if(result.status!=='scored')return unresolved(['RESULT_NEEDS_REVIEW']);
  const scores=Object.fromEntries(result.criteria.map(c=>[c.criterion_id,c.awarded]));
  return {scores,total:sumScores(Object.values(scores)),source:'ai',flags:[]};
}
