"use client";

import { useId, useRef, useState, type InputHTMLAttributes } from "react";
import { Check, ChevronDown, FileText, FolderOpen, RefreshCw, Trash2, Upload } from "lucide-react";
import "./upload-controls.css";

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

type TeachingMaterialUploadProps = {
  label: string;
  number: number;
  file: File | null;
  accept: string;
  formatHint: string;
  disabled?: boolean;
  onChange: (file: File | null) => void;
};

/** The selected file remains in the browser; selecting here does not upload it. */
export function TeachingMaterialUpload({
  label, number, file, accept, formatHint, disabled = false, onChange,
}: TeachingMaterialUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const statusId = useId();

  function remove() {
    if (disabled) return;
    if (inputRef.current) inputRef.current.value = "";
    onChange(null);
    chooseRef.current?.focus();
  }

  return <section className={`material-upload${file ? " is-selected" : ""}`} aria-labelledby={titleId}>
    <div className="material-upload-heading">
      <span className="upload-step">{String(number).padStart(2, "0")}</span>
      {file && <span className="upload-selected-badge"><Check size={14} aria-hidden="true"/>已选择</span>}
    </div>
    <FileText className="material-upload-icon" size={25} strokeWidth={1.6} aria-hidden="true"/>
    <h3 id={titleId}>{label}</h3>
    <div id={statusId} className="material-file-status" role="status" aria-live="polite" aria-atomic="true">
      {file ? <><strong className="material-file-name">{file.name}</strong><span className="material-file-size">{fileSize(file.size)}</span></> : <span className="material-file-placeholder">尚未选择文件</span>}
    </div>
    <p className="material-format-hint">{formatHint}</p>
    <div className="upload-actions">
      <button ref={chooseRef} type="button" className="upload-choose-button" disabled={disabled}
        aria-label={`${file ? "替换" : "选择"}${label}文件`} aria-describedby={statusId}
        onClick={() => inputRef.current?.click()}>
        {file ? <RefreshCw size={14} aria-hidden="true"/> : <Upload size={14} aria-hidden="true"/>}{file ? "替换文件" : "选择文件"}
      </button>
      {file && <button type="button" className="upload-remove-button" disabled={disabled} aria-label={`移除${label}文件`} onClick={remove}>
        <Trash2 size={14} aria-hidden="true"/>移除
      </button>}
    </div>
    <input ref={inputRef} className="upload-native-input" type="file" accept={accept} disabled={disabled}
      aria-label={`${label}文件`} onChange={event => {
        const next = event.currentTarget.files?.[0];
        // Clearing the native value lets choosing the same file fire change again.
        event.currentTarget.value = "";
        if (next && !disabled) onChange(next);
      }}/>
  </section>;
}

type AnswerFileUploadProps = {
  files: File[];
  individualPDFs?: boolean;
  disabled?: boolean;
  /** False after a batch is created: rebind the complete original set instead. */
  removeAllowed?: boolean;
  lockedMessage?: string;
  onChange: (files: File[]) => void | Promise<void>;
};

export function AnswerFileUpload({
  files, individualPDFs = false, disabled = false, removeAllowed = true,
  lockedMessage = "批次已建立，文件清单已锁定。可重新选择原卷关联；更换或移除答卷请先备份，再开启新批次。",
  onChange,
}: AnswerFileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const [visibleCount, setVisibleCount] = useState(50);
  const titleId = useId();
  const listId = useId();
  const statusId = useId();
  const title = individualPDFs ? "原始答卷 PDF" : "本地答题卡文件夹";
  const selectionName = individualPDFs ? "PDF 文件" : "文件夹";
  const directoryProps = individualPDFs ? {} : {
    webkitdirectory: "", directory: "",
  } as InputHTMLAttributes<HTMLInputElement>;

  function removeAt(index: number) {
    if (disabled || !removeAllowed) return;
    if (inputRef.current) inputRef.current.value = "";
    void onChange(files.filter((_, i) => i !== index));
    // Keep keyboard users at a usable control after their focused row disappears.
    chooseRef.current?.focus();
  }

  function clearAll() {
    if (disabled || !removeAllowed) return;
    if (inputRef.current) inputRef.current.value = "";
    void onChange([]);
    setVisibleCount(50);
    chooseRef.current?.focus();
  }

  return <section className={`answer-upload${files.length ? " is-selected" : ""}`} aria-labelledby={titleId}>
    <div className="answer-upload-summary">
      <FolderOpen className="answer-upload-icon" size={25} aria-hidden="true"/>
      <div className="answer-upload-description">
        <h3 id={titleId}>{title}</h3>
        <p id={statusId} role="status" aria-live="polite" aria-atomic="true">
          {files.length ? <span className="answer-upload-count"><Check size={14} aria-hidden="true"/>已选择 {files.length} 个文件</span> : "每位同学一份 学号.pdf，保留身份首页"}
        </p>
      </div>
      <button ref={chooseRef} type="button" className="upload-choose-button" disabled={disabled}
        aria-label={`${files.length ? "重新选择" : "选择"}${selectionName}`} aria-describedby={statusId}
        onClick={() => inputRef.current?.click()}>
        {files.length ? <RefreshCw size={14} aria-hidden="true"/> : <Upload size={14} aria-hidden="true"/>}
        {files.length ? "重新选择" : `选择${selectionName}`}
      </button>
    </div>
    <input key={individualPDFs ? "files" : "folder"} ref={inputRef} className="upload-native-input" type="file" accept=".pdf" multiple
      {...directoryProps} disabled={disabled} aria-label={title} onChange={event => {
        const next = Array.from(event.currentTarget.files || []);
        event.currentTarget.value = "";
        if (next.length && !disabled) {
          setVisibleCount(50);
          void onChange(next);
        }
      }}/>
    {!!files.length && <details className="answer-file-details">
      <summary aria-controls={listId}><span>查看已选文件 · {files.length} 个</span><ChevronDown size={15} aria-hidden="true"/></summary>
      <div id={listId}>
        {removeAllowed && <div className="answer-list-toolbar"><span>移除仅影响待选列表，不删除电脑文件。</span><button className="upload-remove-button" type="button" disabled={disabled} onClick={clearAll}><Trash2 size={14} aria-hidden="true"/>清空已选文件</button></div>}
        <ul className="answer-file-list">
          {files.slice(0, visibleCount).map((file, index) => {
            const path = file.webkitRelativePath || file.name;
            return <li key={`${path}:${index}`}><FileText size={16} aria-hidden="true"/>
              <div><span className="answer-file-name">{path}</span><span className="answer-file-size">{fileSize(file.size)}</span></div>
              {removeAllowed && <button className="upload-remove-button" type="button" disabled={disabled} aria-label={`移除答卷 ${path}`} onClick={() => removeAt(index)}><Trash2 size={14} aria-hidden="true"/><span>移除</span></button>}
            </li>;
          })}
        </ul>
        {files.length > visibleCount && <button className="upload-more-button" type="button" onClick={() => setVisibleCount(count => count + 50)}>再显示 {Math.min(50, files.length - visibleCount)} 个文件（还有 {files.length - visibleCount} 个）</button>}
      </div>
    </details>}
    {!removeAllowed && <p className="upload-locked-note">{lockedMessage}</p>}
  </section>;
}
