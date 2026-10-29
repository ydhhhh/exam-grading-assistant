/** Read-only comparison of initial and model-review results. Human decisions stay separate. */
import {sumScores,validateResult} from './validation.mjs';

function resultView(result,task) {
  const scores=new Map();
  if(!result||!Array.isArray(result.criteria)||!result.criteria.length)return {scores,total:null,valid:false,settled:false};
  let valid=['scored','needs_review'].includes(result.status)&&Array.isArray(result.flags);
  for(const point of result.criteria){
    const id=point?.criterion_id,value=point?.awarded;
    if(typeof id!=='string'||!id||scores.has(id)||!(value===null||(typeof value==='number'&&Number.isFinite(value)&&value>=0)))valid=false;
    if(typeof id==='string')scores.set(id,value);
  }
  // The workflow validates accepted results too; retaining this check prevents a
  // malformed record being presented as agreement before that boundary is reached.
  if(valid&&task.question){
    try{validateResult(result,task.question,(task.pages||[]).map(page=>page.page_id));}catch{valid=false;}
  }
  const settled=valid&&result.status==='scored'&&result.flags.length===0&&[...scores.values()].every(value=>value!==null);
  let total=null;
  if(settled){try{total=sumScores([...scores.values()]);}catch{valid=false;}}
  return {scores,total,valid,settled:settled&&valid};
}

/**
 * Results are compared by criterion ID, never by total alone. A null award is
 * unresolved rather than zero. Differences remain visible after human review.
 */
export function getModelReviewSummary(task) {
  const initial=resultView(task.result,task),review=resultView(task.modelReview,task);
  const ids=[...new Set([...initial.scores.keys(),...review.scores.keys()])];
  const disagreements=ids.filter(id=>initial.scores.has(id)&&review.scores.has(id)&&initial.scores.get(id)!==review.scores.get(id)).map(criterionId=>({criterionId,initial:initial.scores.get(criterionId),review:review.scores.get(criterionId)}));
  let status;
  if(task.modelReviewState===undefined||task.modelReviewState===null)status='disabled';
  else if(['pending','running','error','uncertain'].includes(task.modelReviewState))status=task.modelReviewState;
  else if(task.modelReviewState!=='done'||!initial.valid||!review.valid||initial.scores.size!==review.scores.size||ids.length!==initial.scores.size)status='unresolved';
  else if(disagreements.length)status='disagreement';
  else if(initial.settled&&review.settled)status='agreed';
  else status='unresolved';
  const flag={pending:'MODEL_REVIEW_PENDING',running:'MODEL_REVIEW_RUNNING',error:'MODEL_REVIEW_FAILED',uncertain:'MODEL_REVIEW_UNCERTAIN',unresolved:'MODEL_REVIEW_UNRESOLVED',disagreement:'MODEL_REVIEW_DISAGREEMENT'}[status];
  return {status,differences:disagreements.map(item=>item.criterionId),disagreements,initialTotal:initial.total,reviewTotal:review.total,flags:flag?[flag]:[]};
}

export const computeReviewComparison=getModelReviewSummary;
