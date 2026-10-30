/** Read-only presentation helpers. Never change a task, request ledger, or grade. */
import {getModelReviewSummary} from './review-comparison.mjs';

export const RESULT_FILTERS = Object.freeze([
  {id:'all', label:'全部'},
  {id:'attention', label:'需处理'},
  {id:'identity', label:'身份待核对'},
  {id:'disagreement', label:'分差 > 2 待确认'},
  {id:'instruction', label:'疑似干扰指令'},
  {id:'failed', label:'评分失败'},
  {id:'uncertain', label:'费用未定'},
  {id:'complete', label:'已完成'},
]);

const FILTER_IDS = new Set(RESULT_FILTERS.map(item=>item.id));
const IDENTITY_ISSUES = new Set(['conflict','missing_id','duplicate','roster_mismatch']);
const hasScore = item=>typeof item?.advice?.total==='number'&&Number.isFinite(item.advice.total);
const normalizedQuery = value=>String(value??'').trim().toLocaleLowerCase();
const includesQuery = (values,query)=>!query||values.some(value=>String(value??'').toLocaleLowerCase().includes(query));

/** Model-reported concern, not a misconduct finding. Keep evidence after human resolution. */
export function getInstructionWarnings(task) {
  return [['初评',task?.result],['模型复核',task?.modelReview]].flatMap(([source,result])=>
    (result?.flags||[]).filter(flag=>flag.code==='UNTRUSTED_INSTRUCTION').map(flag=>({...flag,source}))
  );
}

/** Active requests have ordinary reservations, not unresolved billing errors. */
export function hasUncertainCost(attempts=[]) {
  return attempts.some(attempt=>attempt.costCny===null&&attempt.state!=='in_flight');
}

function identityFlags(document,status=document?.mappingStatus) {
  const inputMissing=!!document?.inputError||status==='input_error';
  const identity=IDENTITY_ISSUES.has(status)||(
    status!=='ready'&&!document?.identityReview&&['error','uncertain'].includes(document?.identityState)
  );
  return {identity,inputMissing,uncertain:hasUncertainCost(document?.attempts)};
}

/** Accepts the existing UI summary: {...task, advice: taskAdvice(...), display: studentDisplay(...)}. */
export function getTaskFlags(item) {
  const document=item.display?.document;
  const identity=identityFlags(document,item.display?.status??document?.mappingStatus);
  const complete=hasScore(item);
  const manuallyResolved=complete&&item.advice.source==='human';
  const inputMissing=identity.inputMissing||item.inputComplete===false||item.state==='input_missing';
  const comparison=getModelReviewSummary(item);
  const disagreement=!manuallyResolved&&(comparison.status==='disagreement'||item.advice?.flags?.includes('MODEL_REVIEW_DISAGREEMENT')===true);
  const instruction=!manuallyResolved&&getInstructionWarnings(item).length>0;
  const failed=!manuallyResolved&&(['error','uncertain'].includes(item.state)||['error','uncertain'].includes(comparison.status)||item.advice?.flags?.includes('RESULT_INVALID')===true);
  const needsReview=!manuallyResolved&&(item.result?.status==='needs_review'||comparison.status==='unresolved'||disagreement||item.advice?.flags?.includes('RESULT_NEEDS_REVIEW')===true);
  const uncertain=identity.uncertain||hasUncertainCost(item.attempts)||hasUncertainCost(item.reviewAttempts);
  return {
    attention:identity.identity||inputMissing||failed||needsReview||instruction||uncertain,
    identity:identity.identity,disagreement,instruction,failed,uncertain,complete,inputMissing,needsReview,
  };
}

function groupTasks(summaries) {
  const byDocument=new Map();
  for(const summary of summaries){
    const id=summary.display?.document?.id??summary.studentId;
    if(!byDocument.has(id))byDocument.set(id,[]);
    byDocument.get(id).push(summary);
  }
  return byDocument;
}

function flagsForDocument(document,related) {
  const own=identityFlags(document);
  const taskFlags=related.map(getTaskFlags);
  const identity=own.identity||taskFlags.some(flags=>flags.identity);
  const inputMissing=own.inputMissing||taskFlags.some(flags=>flags.inputMissing);
  const disagreement=taskFlags.some(flags=>flags.disagreement);
  const instruction=taskFlags.some(flags=>flags.instruction);
  const failed=taskFlags.some(flags=>flags.failed);
  const needsReview=taskFlags.some(flags=>flags.needsReview);
  const uncertain=own.uncertain||taskFlags.some(flags=>flags.uncertain);
  return {
    attention:identity||inputMissing||failed||needsReview||instruction||uncertain,
    identity,disagreement,instruction,failed,uncertain,
    complete:document.mappingStatus==='ready'&&related.length>0&&taskFlags.every(flags=>flags.complete),
    inputMissing,needsReview,
  };
}

/** A PDF is complete only when all its questions have usable suggested/human scores. */
export function getDocumentFlags(document,summaries=[]) {
  return flagsForDocument(document,groupTasks(summaries).get(document.id)??[]);
}

function matchesFilter(flags,filter) {
  return !FILTER_IDS.has(filter)||filter==='all'||flags[filter]===true;
}

function matchesTaskQuery(item,query) {
  return includesQuery([
    item.display?.studentId??item.studentId,item.display?.name,item.display?.document?.path,
    item.display?.document?.filenameStudentId,
  ],query);
}

function matchesDocumentQuery(document,query) {
  return includesQuery([document.studentId,document.name,document.path,document.filenameStudentId],query);
}

/** @template T @param {T[]} summaries @returns {T[]} */
export function filterResults(summaries,{query='',filter='all'}={}) {
  const needle=normalizedQuery(query);
  return summaries.filter(item=>matchesTaskQuery(item,needle)&&matchesFilter(getTaskFlags(item),filter));
}

/** @template T @param {T[]} documents @returns {T[]} */
export function filterDocuments(documents,summaries=[],{query='',filter='all'}={}) {
  const needle=normalizedQuery(query),groups=groupTasks(summaries);
  return documents.filter(document=>matchesDocumentQuery(document,needle)&&matchesFilter(flagsForDocument(document,groups.get(document.id)??[]),filter));
}

function countFlags(flagsList) {
  const counts=Object.fromEntries(RESULT_FILTERS.map(({id})=>[id,0]));
  for(const flags of flagsList){
    counts.all++;
    for(const {id} of RESULT_FILTERS)if(id!=='all'&&flags[id])counts[id]++;
  }
  return counts;
}

/** Counts are scoped to the current search; categories can overlap (e.g. score known, cost unknown). */
export function countResultFilters(summaries,{query=''}={}) {
  const needle=normalizedQuery(query);
  return countFlags(summaries.filter(item=>matchesTaskQuery(item,needle)).map(getTaskFlags));
}

export function countDocumentFilters(documents,summaries=[],{query=''}={}) {
  const needle=normalizedQuery(query),groups=groupTasks(summaries);
  return countFlags(documents.filter(document=>matchesDocumentQuery(document,needle)).map(document=>flagsForDocument(document,groups.get(document.id)??[])));
}

/**
 * Clamping prevents a stale page number from hiding results after search/filter changes.
 * @template T
 * @param {T[]} items
 */
export function paginate(items,page=1,pageSize=50) {
  const size=Number.isFinite(pageSize)?Math.max(1,Math.trunc(pageSize)):50;
  const total=items.length,pageCount=Math.max(1,Math.ceil(total/size));
  const current=Math.min(pageCount,Math.max(1,Number.isFinite(page)?Math.trunc(page):1));
  const offset=(current-1)*size;
  return {items:items.slice(offset,offset+size),page:current,pageCount,total,start:total?offset+1:0,end:Math.min(total,offset+size)};
}
