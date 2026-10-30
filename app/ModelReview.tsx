"use client";

import { computeReviewComparison } from "@/lib/grading/review-comparison.mjs";
import { getInstructionWarnings } from "@/lib/grading/result-filters.mjs";

export function InstructionConcern({task,hideDetails=false}:{task:any,hideDetails?:boolean}) {
  const warnings=getInstructionWarnings(task);
  if(!warnings.length)return null;
  return <section className="instruction-concern" aria-label="疑似干扰指令提示">
    <strong>{task.review?"干扰指令提示 · 已人工核查":"疑似干扰评分的内容 · 待人工核查"}</strong>
    <p>这是模型报告的疑点，不代表作弊认定，也不会自动扣分。请对照原卷，仅根据实际作答和教师规则确认分数。</p>
    {!hideDetails&&warnings.map((warning:any,index:number)=><div key={index}><b>{warning.source} · 证据 {warning.evidence_refs.join("、")}</b><p>{warning.detail}</p></div>)}
    {!task.review&&<small>核查前建议分与总分留空；任何一轮报告的疑点都不会被另一轮的高分消除。</small>}
  </section>;
}

export const modelReviewLabels:Record<string,string> = {
  disabled:"未启用模型复核", pending:"等待模型复核", running:"模型复核中",
  error:"模型复核失败", uncertain:"复核请求待核查", agreed:"本题两次同分", adjusted:"分差 ≤ 2 · 已合成建议",
  disagreement:"本题分差 > 2 · 待确认", unresolved:"复核仍有待定项",
};

export function ModelReviewSummary({task,profile,hideScores=false}:{task:any,profile:any,hideScores?:boolean}) {
  const comparison=computeReviewComparison(task);
  if(comparison.status==="disabled")return null;
  return <section className={`model-review-summary ${comparison.status}`} aria-label="模型复核结果">
    <div className="model-review-heading"><strong>{task.review?"已由人工确认":modelReviewLabels[comparison.status]}</strong><span>{profile?.model}</span></div>
    {!hideScores&&<div className="stage-scores"><span>初评 <b>{comparison.initialTotal??"待定"}</b></span><span>复核 <b>{comparison.reviewTotal??"待定"}</b></span>{comparison.suggestedTotal!==null&&<span>本题 AI 建议 <b>{comparison.suggestedTotal}</b></span>}</div>}
    <p>{task.review?"导出采用人工确认分；两次模型结果继续保留。":comparison.status==="adjusted"?"本题两次得分不同、分差不超过 2 分，建议分取平均后向上取整；不修改两份原始评分。":comparison.status==="disagreement"?"本题两次得分相差超过 2 分，请对照原卷人工确认。本题建议分及试卷总分暂留空。":comparison.status==="agreed"?(comparison.differences.length?"本题两次得分相同，采用该分数。评分点分配的差异继续保留，可展开查看。":"本题两次得分相同，采用该分数，仍属于 AI 建议成绩。" ):comparison.status==="pending"?"初评完成后，将使用配置的复核模型核对原作答与评分规则。":comparison.status==="unresolved"?"本题仍有待定项、异常标记或材料不完整，须人工核查；不会仅凭小分差自动采用。":"本题尚未完成模型复核。已保存的初评保留，不自动补发失败请求。"}</p>
    {!hideScores&&comparison.cappedAtMax&&<p>向上取整会超过本题的小数满分，建议分已限制为本题满分。</p>}
    {task.modelReviewError&&<p role="status">{task.modelReviewError}</p>}
  </section>;
}

export function ModelReviewCriterion({task,criterionId}:{task:any,criterionId:string}) {
  if(!task.modelReviewState)return null;
  const initial=task.result?.criteria.find((c:any)=>c.criterion_id===criterionId);
  const review=task.modelReview?.criteria.find((c:any)=>c.criterion_id===criterionId);
  const differs=initial&&review&&initial.awarded!==review.awarded;
  return <div className={`model-review-reason ${differs?"differs":""}`}>
    <b>模型复核 · {review?(review.awarded===null?"待定":`${review.awarded} 分`):"尚无结果"}{differs&&<span className="difference-tag">分值不同</span>}</b>
    {review&&<><p>{review.reason}</p><small>证据：{review.evidence_refs.join("、")}</small></>}
  </div>;
}
