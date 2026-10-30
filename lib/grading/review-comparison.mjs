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
 * Compare the two complete scores for this question, never the whole exam.
 * Criterion differences stay visible; an unknown award is never treated as zero.
 * Suggestions are derived without changing either model's original rubric scores.
 */
export function getModelReviewSummary(task) {
  const initial=resultView(task.result,task),review=resultView(task.modelReview,task);
  const ids=[...new Set([...initial.scores.keys(),...review.scores.keys()])];
  const disagreements=ids.filter(id=>initial.scores.has(id)&&review.scores.has(id)&&initial.scores.get(id)!==review.scores.get(id)).map(criterionId=>({criterionId,initial:initial.scores.get(criterionId),review:review.scores.get(criterionId)}));
  // Scores support four decimal places. Integer units keep the two-point
  // boundary and upward rounding exact (e.g. 1.3 vs 3.3 is exactly two points).
  const initialUnits=initial.total===null?null:Math.round(initial.total*10000);
  const reviewUnits=review.total===null?null:Math.round(review.total*10000);
  const differenceUnits=initialUnits===null||reviewUnits===null?null:Math.abs(initialUnits-reviewUnits);
  const scoreDifference=differenceUnits===null?null:differenceUnits/10000;
  let status,suggestedTotal=null,cappedAtMax=false;
  if(task.modelReviewState===undefined||task.modelReviewState===null)status='disabled';
  else if(['pending','running','error','uncertain'].includes(task.modelReviewState))status=task.modelReviewState;
  else if(task.modelReviewState!=='done'||task.inputComplete===false||task.state==='input_missing'||!initial.settled||!review.settled||initial.scores.size!==review.scores.size||ids.length!==initial.scores.size)status='unresolved';
  else if(differenceUnits===0){status='agreed';suggestedTotal=initial.total;}
  else if(differenceUnits<=20000){
    status='adjusted';
    const rounded=Math.ceil((initialUnits+reviewUnits)/20000);
    const maximum=task.question?.max_score;
    cappedAtMax=typeof maximum==='number'&&Number.isFinite(maximum)&&rounded>maximum;
    suggestedTotal=cappedAtMax?maximum:rounded;
  }else status='disagreement';
  const flag={pending:'MODEL_REVIEW_PENDING',running:'MODEL_REVIEW_RUNNING',error:'MODEL_REVIEW_FAILED',uncertain:'MODEL_REVIEW_UNCERTAIN',unresolved:'MODEL_REVIEW_UNRESOLVED',disagreement:'MODEL_REVIEW_DISAGREEMENT'}[status];
  return {status,differences:disagreements.map(item=>item.criterionId),disagreements,initialTotal:initial.total,reviewTotal:review.total,scoreDifference,suggestedTotal,cappedAtMax,flags:flag?[flag]:[]};
}

export const computeReviewComparison=getModelReviewSummary;
