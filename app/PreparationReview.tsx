"use client";

import { useId, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { validatePack } from "@/lib/grading/validation.mjs";
import styles from "./PreparationReview.module.css";

type RulePack = any;
export type PreparationReviewInput = {
  pack: RulePack;
  resolutions: string[];
  reviewer: string;
  changeSummary: string;
};
type Props = {
  pack: RulePack;
  warnings: string[];
  notes: string[];
  review?: any;
  disabled: boolean;
  onSave: (data: PreparationReviewInput) => Promise<void>;
  onEditingChange?: (dirty: boolean) => void;
};
const clone = (value: any) => JSON.parse(JSON.stringify(value));
function editablePack(pack: RulePack) {
  const value = clone(pack);
  value.approved_by = "";
  value.questions = value.questions.map((q: any) => ({
    ...q,
    max_score: String(q.max_score),
    criteria: q.criteria.map((c: any) => ({
      ...c,
      allowed_scores: c.allowed_scores.join(", "),
      requires: c.requires.join(", "),
    })),
  }));
  return value;
}
function numberValue(value: string, label: string) {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw Error(`${label}请填写非负数字。`);
  const number = Number(text);
  if (!Number.isFinite(number)) throw Error(`${label}不是有效数字。`);
  return number;
}
function checkedPack(draft: RulePack) {
  const value = clone(draft);
  value.approved_by = "";
  value.questions = value.questions.map((q: any) => ({
    ...q,
    max_score: numberValue(q.max_score, `${q.question_id} 满分`),
    criteria: q.criteria.map((c: any) => ({
      ...c,
      allowed_scores: c.allowed_scores.trim().split(/[,，、\s]+/).map((s: string) => numberValue(s, `${q.question_id} / ${c.criterion_id} 允许分值`)),
      requires: c.requires.trim() ? c.requires.trim().split(/[,，、\s]+/) : [],
    })),
  }));
  validatePack(value, {draft: true});
  return value;
}

export default function PreparationReview({pack, warnings, notes, review, disabled, onSave, onEditingChange}: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => editablePack(pack));
  const [resolutions, setResolutions] = useState<string[]>(() => warnings.map((_, index) => review?.resolutions?.[index] || ""));
  const [reviewer, setReviewer] = useState<string>(() => review?.reviewer || "");
  const [changeSummary, setChangeSummary] = useState<string>(() => review?.changeSummary || "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const blocked = disabled || saving;
  function changed() {
    setDirty(true);
    setSaved(false);
    setError("");
    onEditingChange?.(true);
  }
  function updatePack(field: string, value: string) {
    changed();
    setDraft((previous: RulePack) => ({...previous, [field]: value}));
  }
  function updateQuestion(index: number, field: string, value: string) {
    changed();
    setDraft((previous: RulePack) => ({...previous, questions: previous.questions.map((q: any, i: number) => i === index ? {...q, [field]: value} : q)}));
  }
  function updateCriterion(questionIndex: number, criterionIndex: number, field: string, value: string) {
    changed();
    setDraft((previous: RulePack) => ({...previous, questions: previous.questions.map((q: any, i: number) => i === questionIndex ? {...q, criteria: q.criteria.map((c: any, j: number) => j === criterionIndex ? {...c, [field]: value} : c)} : q)}));
  }
  function cancel() {
    setDraft(editablePack(pack));
    setResolutions(warnings.map((_, index) => review?.resolutions?.[index] || ""));
    setReviewer(review?.reviewer || "");
    setChangeSummary(review?.changeSummary || "");
    setDirty(false);
    setSaved(false);
    setError("");
    setOpen(false);
    onEditingChange?.(false);
  }
  async function save() {
    if (blocked) return;
    setError("");
    setSaved(false);
    try {
      const corrected = checkedPack(draft);
      if (!reviewer.trim()) throw Error("请填写核对人姓名或称呼。");
      if (resolutions.length !== warnings.length || resolutions.some(value => !value.trim())) throw Error("请逐项填写处理依据，再保存核对记录。");
      const original = {...pack, approved_by: ""};
      if (JSON.stringify(corrected) !== JSON.stringify(original) && !changeSummary.trim()) throw Error("规则已有修改，请简要说明改了什么及依据。");
      setSaving(true);
      await onSave({pack: corrected, resolutions: resolutions.map(value => value.trim()), reviewer: reviewer.trim(), changeSummary: changeSummary.trim()});
      setDirty(false);
      setSaved(true);
      onEditingChange?.(false);
    } catch (e: any) {
      setError(e?.message || "核对记录未保存，请检查填写内容。");
    } finally {
      setSaving(false);
    }
  }
  return <section className={styles.root} aria-label="评分规则核对与修正">
    {notes.length > 0 && <div className={styles.notes}>
      <h4>规则说明（不阻止确认）</h4>
      <ul>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
    </div>}
    <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={`${id}-editor`} onClick={() => setOpen(value => !value)} disabled={saving}>
      <span>核对并修正规则{dirty && <small>有未保存的修改</small>}</span>{open ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
    </button>
    {open && <div id={`${id}-editor`} className={styles.editor}>
      <p className={styles.help}>修改和保存只在本机进行，不调用 API。请对照教师材料填写；保存核对记录后，仍需确认题号、分值和评分点。</p>
      {disabled && <p className={styles.help}>当前批次已锁定或正在处理，暂不能修改规则。</p>}
      <fieldset disabled={blocked} className={styles.fields}>
        <label>试卷名称<input value={draft.title} maxLength={500} onChange={e => updatePack("title", e.target.value)}/></label>
        <label>评分政策<textarea value={draft.policies} rows={4} maxLength={100000} onChange={e => updatePack("policies", e.target.value)}/></label>
        {draft.questions.map((q: any, qi: number) => <details className={styles.question} key={q.question_id}>
          <summary>{q.question_id} · 核对题目与评分点</summary>
          <div className={styles.questionFields}>
            <label>{q.question_id} 题目<textarea value={q.text} rows={4} maxLength={100000} onChange={e => updateQuestion(qi, "text", e.target.value)}/></label>
            <label>{q.question_id} 参考答案<textarea value={q.solution} rows={4} maxLength={100000} onChange={e => updateQuestion(qi, "solution", e.target.value)}/></label>
            <label className={styles.shortField}>{q.question_id} 满分<input inputMode="decimal" value={q.max_score} maxLength={20} onChange={e => updateQuestion(qi, "max_score", e.target.value)}/></label>
            {q.criteria.map((c: any, ci: number) => <div className={styles.criterion} key={c.criterion_id}>
              <h5>{q.question_id} / {c.criterion_id}</h5>
              <label>{q.question_id} / {c.criterion_id} 评分点说明<textarea value={c.description} rows={3} maxLength={100000} onChange={e => updateCriterion(qi, ci, "description", e.target.value)}/></label>
              <div className={styles.columns}>
                <label>{q.question_id} / {c.criterion_id} 允许分值<input value={c.allowed_scores} maxLength={4000} placeholder="例如：0, 1, 2" onChange={e => updateCriterion(qi, ci, "allowed_scores", e.target.value)}/><small>用逗号或空格分隔，必须包含 0。</small></label>
                <label>{q.question_id} / {c.criterion_id} 前置评分点<input value={c.requires} maxLength={12000} placeholder="没有则留空；例如 C1" onChange={e => updateCriterion(qi, ci, "requires", e.target.value)}/><small>仅填写教师明确要求先得分的评分点编号。</small></label>
              </div>
            </div>)}
          </div>
        </details>)}
        <p className={styles.help}>题号与评分点编号保持不变。缺少整题或评分点时，请补充材料后重新整理，或导入完整规则。</p>
        {warnings.length > 0 && <div className={styles.issues}>
          <h4>逐项核对待处理问题</h4>
          <p>缺漏或冲突需按教师要求修正规则；若提示只是普通说明，请写明判断依据。尚未确定时请先保留待处理状态。</p>
          {warnings.map((warning, index) => <div className={styles.issue} key={index}>
            <p><strong>问题 {index + 1}</strong>：{warning}</p>
            <label>问题 {index + 1} 的处理依据<textarea value={resolutions[index] || ""} rows={3} maxLength={2000} placeholder="说明教师已明确的要求、对应修正，或为何无需改变规则。" onChange={e => {changed(); setResolutions(previous => previous.map((value, i) => i === index ? e.target.value : value));}}/></label>
          </div>)}
        </div>}
        <div className={styles.columns}>
          <label>核对人<input value={reviewer} maxLength={200} placeholder="姓名或称呼" onChange={e => {changed(); setReviewer(e.target.value);}}/></label>
          <label>修改说明<textarea value={changeSummary} rows={3} maxLength={2000} placeholder="修改规则时必填：改了什么，依据是什么。" onChange={e => {changed(); setChangeSummary(e.target.value);}}/></label>
        </div>
      </fieldset>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {saved && <p className={styles.saved} role="status">核对记录已保存，请核对预览后勾选确认。</p>}
      {dirty && <p className={styles.help}>尚未保存的修改不会用于批改；保存或取消后才能确认规则。</p>}
      <div className={styles.actions}>
        <button type="button" className="button secondary" onClick={cancel} disabled={saving}>取消本次修改</button>
        <button type="button" className="button primary" onClick={save} disabled={blocked}>{saving ? "正在保存" : "保存核对记录"}</button>
      </div>
    </div>}
  </section>;
}
