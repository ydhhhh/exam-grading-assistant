"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, FileText, FolderOpen, KeyRound, ArrowRight, Check, ChevronDown, Download, Search, X, Pause, Play, ShieldCheck, RotateCcw, AlertCircle, BookOpen, Eye, EyeOff } from "lucide-react";
import { VERSION, MODEL, validatePack, validateScores, advice } from "@/lib/grading/validation.mjs";
import { canonical, hashJSON, readUpload, indexAnswers, snapshotJob, saveJob, loadJob, importBackup, exportCSV, runJob, rebindJob, requeueTask, demoJob, DEFAULT_SETTINGS, createJob, reviewTask, attachPreparation, clearLastJob, restorePreparationDraft } from "@/lib/grading/browser-workflow.mjs";

type AnyData = any;
const defaultSettings = {...DEFAULT_SETTINGS};
const roleLabels: Record<string,string> = { paper: "试题", solution: "参考答案", rubric: "评分细则" };
const stateLabels: Record<string,string> = {ready:"等待批改", input_missing:"缺少材料", running:"正在批改", done:"已生成建议", error:"调用未完成", uncertain:"请求待核查"};
const money = (v: number) => `¥${Number(v || 0).toFixed(2)}`;
function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function Home() {
  const [documents, setDocuments] = useState<Record<string,File|null>>({paper:null, solution:null, rubric:null});
  const [answerFiles, setAnswerFiles] = useState<File[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [pack, setPack] = useState<AnyData>(null);
  const [packApproved, setPackApproved] = useState(false);
  const [prepareResult, setPrepareResult] = useState<AnyData>(null);
  const [job, setJob] = useState<AnyData>(null);
  const [settings, setSettings] = useState<any>(defaultSettings);
  const [busy, setBusy] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [scores, setScores] = useState<Record<string,string>>({});
  const [reviewer, setReviewer] = useState("");
  const [reason, setReason] = useState("");
  const [retryConsent, setRetryConsent] = useState(false);
  const [uploadConsent, setUploadConsent] = useState(false);
  const [roster, setRoster] = useState("");
  const [hideAI, setHideAI] = useState(false);
  const stopRef = useRef(false);
  const prepRef = useRef<any[]>([]);
  const PREP_KEY = "grading-preparation-v1";
  const jobRef = useRef<AnyData>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const [pageURLs, setPageURLs] = useState<{url:string,name:string,mime:string}[]>([]);

  const updateJob = (next: AnyData) => { jobRef.current=next; setJob({...next, tasks:[...next.tasks]}); };
  useEffect(() => {
    try{const saved=JSON.parse(localStorage.getItem(PREP_KEY)||"[]");if(Array.isArray(saved))prepRef.current=saved;}catch{}
    const draft=restorePreparationDraft(prepRef.current);
    loadJob().then(async(saved:AnyData)=>{
      if(saved){
        await hydrateDemo(saved);updateJob(saved);setPack(saved.pack);setPackApproved(true);setSettings({...defaultSettings,...saved.settings});
        setNotice(saved.demo?"演示进度和原图已恢复，可继续查看或改分，无需密钥。":"已恢复本浏览器的进度。重新选择原答卷文件夹即可查看原图和改分；继续调用 API 时再填写密钥。");
      }else if(draft){
        setPack(draft.pack);setPrepareResult(draft);setPackApproved(false);
        setNotice(draft.warnings.length?"已恢复上次整理的规则草案，其中的提示仍需处理。请补充材料后重新整理。":"已恢复上次整理的规则草案，无需重复调用 API。请重新核对题号、满分和评分点后确认。");
      }
    }).catch(()=>setNotice("浏览器不允许保存进度。请使用普通窗口并允许本地存储后开始批改。"));
  }, []);
  useEffect(() => { const prevent=(e:BeforeUnloadEvent)=>{if(running){e.preventDefault();e.returnValue="";}};window.addEventListener("beforeunload",prevent);return()=>window.removeEventListener("beforeunload",prevent); },[running]);
  const selected = job?.tasks.find((t:AnyData)=>t.id===selectedId);
  useEffect(()=>{
    if(!selected){setPageURLs([]);return;}
    const urls=selected.pages.filter((p:AnyData)=>p.file).map((p:AnyData)=>({url:URL.createObjectURL(p.file),name:p.page_id,mime:p.file.type || (p.path?.endsWith(".pdf")?"application/pdf":"image/jpeg")}));
    setPageURLs(urls);return()=>urls.forEach((p:AnyData)=>URL.revokeObjectURL(p.url));
  },[selectedId,answerFiles,job?.id]);

  async function withAction(label:string,fn:()=>Promise<void>){setBusy(label);setNotice("");try{await fn();}catch(e:any){setNotice(e.message||"操作未完成，请检查材料后重试。");}finally{setBusy("");}}
  const hasDocuments=Object.values(documents).every(Boolean);
  function persistPrep(){localStorage.setItem(PREP_KEY,JSON.stringify(prepRef.current));}
  async function lockedJob(id:string, fn:()=>Promise<void>){
    if(!navigator.locks)throw Error("请使用新版 Chrome 或 Edge 浏览器，以安全保存和运行批次。");
    await navigator.locks.request("grading-job:"+id,{ifAvailable:true},async lock=>{if(!lock)throw Error("这个批次正在另一个页面运行，请先暂停。");await fn();});
  }
  async function hydrateDemo(saved:AnyData){
    if(saved.demo){const fresh=await demoJob();await rebindJob(saved,fresh.tasks.flatMap((t:AnyData)=>t.pages.map((p:AnyData)=>p.file)),{load:async()=>null});}
    return saved;
  }
  function keepBoundPages(latest:AnyData,previous:AnyData){
    const bound=new Map(previous.tasks.flatMap((t:AnyData)=>t.pages.map((p:AnyData)=>[p.path,p])));
    for(const t of latest.tasks)for(const p of t.pages){const prev:any=bound.get(p.path);if(prev?.sha256===p.sha256)p.file=prev.file;}
    return latest;
  }
  async function chooseAnswerFolder(files:File[]){
    setAnswerFiles(files);
    if(!jobRef.current||!files.length)return;
    await withAction("正在关联原答卷",async()=>{
      await lockedJob(jobRef.current.id,async()=>{const latest=await rebindJob({...jobRef.current},files);await saveJob(latest);updateJob(latest);});
      setNotice("已核对并关联原答卷，可以直接查看和改分，无需填写 API key。");
    });
  }
  async function prepareRules(){
    if(!apiKey.trim()){setNotice("请填写自己的 OpenAI API key。密钥只在本次页面中使用。");keyRef.current?.focus();return;}
    if(!uploadConsent){setNotice("请确认将本次材料发送给 OpenAI 进行处理。");return;}
    await withAction("正在整理评分规则",async()=>{
      const docs=[];
      for(const role of ["paper","solution","rubric"]){const file=documents[role];if(!file)throw Error("请先选择三份教学材料。");docs.push({...await readUpload(file,role+"."+file.name.split(".").pop()),role});}
      if(prepRef.current.some(a=>a.costCny===null)&&!window.confirm("此前有规则整理请求费用未定，再次提交可能重复计费。确认继续？"))return;
      const committed=prepRef.current.reduce((n,a)=>n+(a.costCny??a.reservedCny),0);
      if(committed+settings.requestReserveCny>settings.budgetCny)throw Error("预算不足以预留这次规则整理请求，请在更多设置核对预算。");
      const requestId=crypto.randomUUID();
      const attempt:any={id:requestId,lane:"prepare",state:"in_flight",reservedCny:settings.requestReserveCny,costCny:null,sentAt:new Date().toISOString()};
      prepRef.current.push(attempt);persistPrep();
      let response:Response,result:any;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),240000);
      try{
        response=await fetch("/api/prepare",{method:"POST",headers:{"Content-Type":"application/json","X-Api-Key":apiKey.trim()},body:JSON.stringify({documents:docs,requestId}),signal:controller.signal});
        result=JSON.parse(JSON.stringify(await response.json()).split(apiKey.trim()).join("[REDACTED]"));
      }catch{
        attempt.state="uncertain";attempt.uncertain=true;attempt.error="规则整理请求中断，费用未定。";persistPrep();throw Error("规则整理请求中断，可能已计费；再次提交前请核查。原预留已保留。");
      }finally{clearTimeout(timer);}
      attempt.response=result;attempt.usage=result.usage;attempt.requestId=result.requestId;attempt.finishedAt=new Date().toISOString();
      attempt.costCny=typeof result.estimatedCny==="number"?result.estimatedCny:(!response.ok&&result.uncertain===false?0:null);
      attempt.state=response.ok?"done":result.uncertain?"uncertain":"error";persistPrep();
      if(!response.ok)throw Error(result.error||"规则识别没有完成。该请求可能已计费，请查看提示。");
      setPack(result.pack);setPrepareResult(result);setPackApproved(false);
      setNotice(result.warnings?.length?"材料中有需要补充的信息，请查看下面的提示，完善后重新整理。":"评分规则已整理。核对题号、满分和评分点后，即可开始批改。");
    });
  }
  async function acceptPack(){
    if(!pack || !packApproved)throw Error("请先核对整理后的评分规则。");
    const approved={...pack,approved_by:pack.approved_by || "上传者已确认评分规则"};validatePack(approved);
    return approved;
  }
  async function start(){
    if(running||busy)return;
    if(job?.demo){setRunning(true);stopRef.current=false;try{await (runJob as any)(jobRef.current,{apiKey:"",onChange:updateJob,shouldStop:()=>stopRef.current});}catch(e:any){setNotice(e.message);}finally{setRunning(false);}return;}
    if(!apiKey.trim()){setNotice("请填写 API key 后继续。");keyRef.current?.focus();return;}
    if(!uploadConsent){setNotice("请勾选材料发送确认。只有当前题目的匿名答卷会分批发送。");return;}
    await withAction("正在检查本地答卷",async()=>{
      const approved=await acceptPack();
      if(!answerFiles.length)throw Error("请选择本地答题卡文件夹。");
      let next=jobRef.current;
      if(next){await lockedJob(next.id,async()=>{next=await rebindJob(next,answerFiles);await saveJob(next);});}
      else{
        next=await createJob(approved,answerFiles,settings,roster.split(/\r?\n/).map(s=>s.trim()).filter(Boolean));
        attachPreparation(next,prepRef.current);
        if(next.warnings?.length)setNotice(next.warnings.join("；"));
        await saveJob(next);
      }
      updateJob(next);setPack(approved);
      resultsRef.current?.scrollIntoView({behavior:"smooth"});
      setRunning(true);stopRef.current=false;
      try{await (runJob as any)(next,{apiKey:apiKey.trim(),onChange:updateJob,shouldStop:()=>stopRef.current});}
      finally{setRunning(false);}
    });
  }
  async function loadDemo(){
    if(job&&!window.confirm("当前进度会被新的演示替代。需要保留时请先下载进度备份。继续吗？"))return;
    await withAction("准备演示",async()=>{const next=await demoJob();await saveJob(next);updateJob(next);setPack(next.pack);setPackApproved(true);setApiKey("");setSearch("");setSelectedId("");setNotice("这是合成演示，不连接 API。点击“开始演示”即可看到自动建议和分歧提示。");});
  }
  async function reset(){if(!window.confirm("开启新批次会替换本浏览器的当前进度。请先下载进度备份。继续吗？"))return;await clearLastJob();prepRef.current=[];localStorage.removeItem(PREP_KEY);jobRef.current=null;setJob(null);setSelectedId("");setPack(null);setPrepareResult(null);setPackApproved(false);setAnswerFiles([]);setApiKey("");setNotice("已开启新批次。上次已下载的备份仍可重新导入。");}
  function backup(){if(job)download("阅卷进度_"+job.id.slice(0,8)+".json",JSON.stringify(snapshotJob(job),null,2));}
  async function loadPack(file:File){await withAction("读取统一规则",async()=>{if(job)throw Error("请先下载当前进度并开启新批次，再更换规则。");const raw=JSON.parse(await file.text());validatePack(raw);if(raw.demo)throw Error("合成规则不能用于真实答卷，请使用真实统一规则。");setPack(raw);setPrepareResult(null);setPackApproved(true);setNotice("已导入统一规则，不需要再次上传试题、答案和细则。");});}
  async function restore(file:File){await withAction("恢复进度",async()=>{if(job&&!window.confirm("用备份替换当前进度？请先下载当前进度以免丢失。"))return;const restored=await hydrateDemo(await importBackup(await file.text()));await lockedJob(restored.id,async()=>{await saveJob(restored);});updateJob(restored);setPack(restored.pack);setPackApproved(true);setSettings({...defaultSettings,...restored.settings});setAnswerFiles([]);setSelectedId("");setNotice(restored.demo?"演示备份及原图已恢复，可直接查看或改分。":"备份已恢复。重新选择原答卷文件夹即可查看和改分；继续批改时再填写密钥。");});}
  function chooseTask(t:AnyData){setSelectedId(t.id);const current=advice(t);setScores(Object.fromEntries(t.question.criteria.map((c:AnyData)=>[c.criterion_id,current.scores?.[c.criterion_id]?.toString()??""])));setReason("");setRetryConsent(false);}
  async function saveReview(){await withAction("保存改分",async()=>{
    if(!selected)throw Error("请先选择题目。");
    if(!reviewer.trim())throw Error("请填写复核人。");
    const values=Object.fromEntries(Object.entries(scores).map(([k,v])=>{if(v==="")throw Error("请为所有评分点选择分数。");return [k,Number(v)];}));
    await lockedJob(jobRef.current.id,async()=>{
      const latest=await loadJob(jobRef.current.id)||jobRef.current;
      keepBoundPages(latest,jobRef.current);
      const target=latest.tasks.find((t:AnyData)=>t.id===selected.id);
      reviewTask(target,values,reviewer.trim(),reason.trim());await saveJob(latest);updateJob(latest);
    });setNotice("改分已保存，导出采用新分数。理由可以留空。");
  });}
  async function retrySelected(){await withAction("重新排队",async()=>{
    if(!selected)return;
    await lockedJob(jobRef.current.id,async()=>{const latest=keepBoundPages(await loadJob(jobRef.current.id)||jobRef.current,jobRef.current);const target=latest.tasks.find((t:AnyData)=>t.id===selected.id);requeueTask(target,retryConsent);await saveJob(latest);updateJob(latest);});
    setNotice("已重新排队。点击继续批改即可重试。");
  });}

  const disabled=!!busy||running;
  const tasks:AnyData[]=job?.tasks||[];
  const summaries=tasks.map(t=>({...t,advice:advice(t)}));
  const filtered=summaries.filter(t=>String(t.studentId).toLowerCase().includes(search.trim().toLowerCase()));
  const completed=summaries.filter(t=>t.advice.total!==null).length;
  const reviewCount=tasks.filter(t=>t.review).length;
  const studentIds=Array.from(new Set(filtered.map(t=>t.studentId)));
  const oneStudent=studentIds.length===1?studentIds[0]:null;
  const studentTasks=oneStudent?summaries.filter(t=>t.studentId===oneStudent):[];
  const studentTotal=studentTasks.length&&studentTasks.every(t=>t.advice.total!==null)?Math.round(studentTasks.reduce((s,t)=>s+t.advice.total,0)*10000)/10000:null;

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/"><span className="brand-icon"><BookOpen size={22}/></span><span>阅卷助手<small>统一标准 · 自动建议 · 按需复核</small></span></a><div className="header-actions"><span className="tag"><ShieldCheck size={14}/>各自密钥 · 本机进度</span><button className="text-button" onClick={loadDemo} disabled={disabled}>先体验演示 <ArrowRight size={15}/></button></div></header>
    <main>
      <section className="intro"><div><span className="eyebrow">给助教的一张工作台</span><h1>把材料放进来，<br className="mobile-break"/>让批改简单一点。</h1><p>上传统一材料，选择答卷文件夹，等待建议成绩。需要时，再按学号复核。</p></div><div className="intro-note"><span>01 准备材料</span><ArrowRight size={16}/><span>02 自动批改</span><ArrowRight size={16}/><span>03 导出成绩</span></div></section>
      {notice&&<div className="message" role="status"><AlertCircle size={18}/><span>{notice}</span><button aria-label="关闭提示" onClick={()=>setNotice("")}><X size={16}/></button></div>}
      {job?.demo&&<div className="demo-banner">当前为合成演示 · 不调用 API · 演示分数不代表真实评分效果 <button onClick={reset} disabled={disabled}>切换到真实批次</button></div>}
      <section className="workspace-card">
        <div className="section-title"><div><h2>准备本次批改</h2><p>只需这些材料。技术设置已经收好。</p></div><div className="quiet-links"><label className="file-link">导入统一规则<input type="file" accept=".json" disabled={disabled||!!job} onChange={e=>e.target.files?.[0]&&loadPack(e.target.files[0])}/></label><label className="file-link">恢复进度<input type="file" accept=".json" disabled={disabled} onChange={e=>e.target.files?.[0]&&restore(e.target.files[0])}/></label>{job&&<button className="text-button" onClick={reset} disabled={disabled}>新批次</button>}</div></div>
        {packApproved&&pack&&!job?.demo?<div className="pack-ready"><Check size={18}/><span>已采用统一规则：{pack.title} · {pack.questions.length} 题 · {pack.questions.reduce((a:number,q:AnyData)=>a+q.max_score,0)} 分</span>{!job&&<button className="text-button" disabled={disabled} onClick={()=>{setPack(null);setPackApproved(false);setPrepareResult(null);}}>重新选择材料</button>}</div>:<div className="document-grid">{["paper","solution","rubric"].map((role,index)=><label className={"upload-tile "+(documents[role]?"has-file":"")} key={role}><span className="tile-number">0{index+1}</span><FileText size={25} strokeWidth={1.5}/><strong>{roleLabels[role]}</strong><span className="upload-name">{documents[role]?.name||"点击选择文件"}</span><small>PDF / Word / 图片 / 文本 · ≤3 MiB</small><input type="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp" disabled={disabled||!!job} onChange={e=>{setDocuments({...documents,[role]:e.target.files?.[0]||null});setPack(null);setPackApproved(false);setPrepareResult(null);}}/></label>)}</div>}
        <div className="input-grid"><div className="folder-section"><label className={"folder-box "+(answerFiles.length?"has-file":"")}><span className="input-icon"><FolderOpen size={24}/></span><span><strong>本地答题卡文件夹</strong><small>{answerFiles.length?`已选择 ${answerFiles.length} 个文件` : "点击选择文件夹，支持同题续页"}</small></span><span className="select-button">选择文件夹</span><input type="file" multiple {...({webkitdirectory:"",directory:""} as any)} disabled={disabled||job?.demo} onChange={e=>chooseAnswerFolder(Array.from(e.target.files||[]))}/></label><details className="folder-help"><summary>文件夹怎么放？<ChevronDown size={13}/></summary><p>按“学号 → 题号 → 页面”存放，例如 <code>2026001/Q1/01.jpg</code>、<code>2026001/Q1/02.jpg</code>。也支持 <code>2026001_Q1_01.jpg</code>。每题可用图片或PDF；整份试卷PDF请先按题拆分。不要选择姓名学号首页。</p><p>单文件最大3 MiB，每题合计6 MiB。文件编号请用01、02排序。完全漏掉的同学无法从文件夹推断，可在更多设置填写应收名单。</p></details></div><div className="key-section"><label htmlFor="api-key"><KeyRound size={17}/>你的 OpenAI API key</label><div className="key-input"><input id="api-key" ref={keyRef} type={showKey?"text":"password"} autoComplete="off" spellCheck={false} placeholder="填写自己的密钥" value={apiKey} disabled={disabled} onChange={e=>setApiKey(e.target.value)}/><button aria-label={showKey?"隐藏密钥":"显示密钥"} onClick={()=>setShowKey(!showKey)} type="button">{showKey?<EyeOff size={17}/>:<Eye size={17}/>}</button></div><small>只在本次页面使用，不写进进度、导出文件或公开网页。</small></div></div>
        <details className="advanced"><summary>更多设置与费用 <ChevronDown size={14}/></summary><div className="advanced-body"><p>默认使用 {MODEL}，独立批改两次。A为主评、B作质检；不是本课程已验收模型。费用根据当前用量估算，以服务商账单为准。</p><div className="advanced-grid"><label>本批预算（元）<input type="number" min="5" max="5000" value={settings.budgetCny} disabled={!!job||disabled} onChange={e=>setSettings({...settings,budgetCny:Number(e.target.value)})}/></label><label>每分钟请求数<select value={settings.requestsPerMinute} disabled={!!job||disabled} onChange={e=>setSettings({...settings,requestsPerMinute:Number(e.target.value)})}>{[1,2,5,10].map(n=><option key={n} value={n}>{n} 次</option>)}</select></label><label>单次费用预留（元）<input type="number" min="1" max="100" value={settings.requestReserveCny} disabled={!!job||disabled} onChange={e=>setSettings({...settings,requestReserveCny:Number(e.target.value)})}/></label></div><label className="roster-label">应收学号名单（选填，每行一个；可发现完全漏交的同学）<textarea rows={3} value={roster} disabled={!!job||disabled} onChange={e=>setRoster(e.target.value)} placeholder="2026001&#10;2026002"/></label><p>共享同一 API 项目的助教可能共享限额。预算含不确定请求的预留；不会自动重试可能已计费的调用。人民币换算暂按7.5作预算系数，不是实时汇率。</p></div></details>
        {pack&&<div className="rule-preview"><div className="rule-heading"><h3>{pack.title || "评分规则预览"}</h3><span>{pack.questions.length} 题 · {pack.questions.reduce((s:number,q:AnyData)=>s+q.max_score,0)} 分</span></div>{prepareResult?.warnings?.length>0&&<div className="rule-warning">{prepareResult.warnings.map((w:string,i:number)=><p key={i}>{w}</p>)}</div>}<div className="question-chips">{pack.questions.map((q:AnyData)=><details key={q.question_id}><summary>{q.question_id}<b>{q.max_score} 分</b><ChevronDown size={13}/></summary><div><p>{q.text}</p><p>参考答案：{q.solution}</p>{q.criteria.map((c:AnyData)=><p key={c.criterion_id}><strong>{c.criterion_id}：</strong>{c.description}<br/><small>允许分值：{c.allowed_scores.join(" / ")}</small></p>)}</div></details>)}</div><details className="review-rules"><summary>评分政策<ChevronDown size={14}/></summary><p>{pack.policies}</p></details>{!packApproved&&!job&&<label className="checkline"><input type="checkbox" checked={packApproved} disabled={!!prepareResult?.warnings?.length} onChange={e=>setPackApproved(e.target.checked)}/>我已核对题号、满分和评分点与教师要求一致。</label>}<button className="text-button" disabled={!packApproved||disabled} onClick={async()=>{try{const p=await acceptPack();download("统一评分规则.json",JSON.stringify(p,null,2));}catch(e:any){setNotice(e.message);}}}><Download size={14}/>下载统一规则，供其他助教直接导入</button></div>}
        {!job?.demo&&<label className="checkline upload-consent"><input type="checkbox" checked={uploadConsent} onChange={e=>setUploadConsent(e.target.checked)} disabled={disabled}/>我确认使用这些材料进行 API 处理；答卷图像已去除身份信息，并理解会产生 API 费用。</label>}
        <div className="start-row"><p><ShieldCheck size={16}/>{job?.demo?"演示不需要密钥，也不会联网批改":"本地选择文件，按题发送 · 答卷不会保存在网站数据库"}</p>{running?<button className="button primary" onClick={()=>{stopRef.current=true;setNotice("已请求暂停；当前请求完成并保存后会停止。");}}><Pause size={17}/>暂停批改</button>:<button className="button primary" disabled={!!busy||(!pack&&!hasDocuments)} onClick={pack?start:prepareRules}>{busy?<span className="spinner"/>:job?.demo?<Play size={17}/>:<ArrowRight size={17}/>} {busy||(!pack?"整理评分规则":job?.demo?"开始演示":job?"继续批改":"开始批改")}</button>}</div>
      </section>
      <section className="results-section" ref={resultsRef}><div className="section-title"><div><h2>建议成绩与可选复核</h2><p>批改完成即可导出。想查看哪位同学，输入学号就好。</p></div>{job&&<div className="quiet-links"><button className="text-button" onClick={backup} disabled={disabled}><Download size={15}/>进度备份</button><button className="button secondary" onClick={()=>download("AI建议成绩.csv",exportCSV(job),"text/csv;charset=utf-8")}><Download size={16}/>导出建议成绩</button></div>}</div>{!job?<div className="empty-state"><span><FileText size={32} strokeWidth={1.2}/></span><h3>成绩会出现在这里</h3><p>准备好材料后开始批改，或先体验无需密钥的演示。</p></div>:<><div className="stats-row"><div><span>本批任务</span><strong>{tasks.length}<small>题</small></strong></div><div><span>已生成建议</span><strong>{completed}<small>题</small></strong></div><div><span>人工改分 · 可选</span><strong>{reviewCount}<small>题</small></strong></div><div><span>费用估算 + 未决预留</span><strong className="cost">{money((job.spentCny||0)+(job.heldCny||0))}<small>/ {money(job.settings.budgetCny)}</small></strong></div></div><div className="progress"><i style={{width:`${tasks.length?100*completed/tasks.length:0}%`}}/></div><div className="result-toolbar"><div className="search-box"><Search size={18}/><input aria-label="按学号搜索" value={search} onChange={e=>setSearch(e.target.value)} placeholder="输入学号，查看该同学"/></div><span>{running?"正在批改，请保持此页面打开":oneStudent?`${oneStudent} · 建议总分 ${studentTotal===null?"未完成":studentTotal}`:"进度保存在此浏览器，可随时下载备份"}</span></div><div className="table-scroll"><table><thead><tr><th>学号</th><th>题号</th><th>建议分</th><th>状态</th><th>分数来源</th><th></th></tr></thead><tbody>{filtered.slice(0,200).map(t=><tr key={t.id}><td className="student-cell">{t.studentId}</td><td>{t.questionId}</td><td className="score-cell">{t.advice.total===null?"—":t.advice.total}<small> / {t.question.max_score}</small></td><td><span className={"state "+(t.advice.total!==null?"complete":"")}>{t.advice.flags?.length&&t.advice.total!==null?"有质检提示":stateLabels[t.state]||t.state}</span></td><td>{t.advice.source==="human"?"人工改分":t.advice.source==="ai"?"AI建议":"待定"}</td><td><button className="text-button" onClick={()=>chooseTask(t)}>查看 / 改分 <ArrowRight size={14}/></button></td></tr>)}</tbody></table>{filtered.length>200&&<p className="table-note">目前显示前200题，输入学号可定位其余结果。</p>}{!filtered.length&&<p className="table-note">没有找到这个学号。</p>}</div><p className="results-note">A路提供建议，B路分歧单独提示；人工改分优先。缺页、读不清和调用失败不按零分处理，未完成题目使总分留空。自动结果是建议成绩，正式用途仍需教师确认。</p></>}</section>
      <footer><span>阅卷助手 · 网页版</span><p>无需安装 · 密钥仅用于本次会话 · 页面关闭后不会继续后台批改</p><a href="https://developers.openai.com/api/docs/models/gpt-6.1-terra" target="_blank" rel="noreferrer">模型与费用说明 ↗</a></footer>
    </main>
    {selected&&<div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)setSelectedId("");}}><section className="review-modal" role="dialog" aria-modal="true" aria-label="可选人工复核"><div className="modal-header"><div><span className="eyebrow">可选人工复核</span><h2>{selected.studentId} <small>· {selected.questionId}</small></h2></div><button className="icon-button" aria-label="关闭复核" onClick={()=>setSelectedId("")}><X size={22}/></button></div><div className="review-columns"><div className="evidence-panel"><h3>原图与续页</h3>{pageURLs.length?pageURLs.map(p=><figure key={p.name}>{p.mime==="application/pdf"?<a href={p.url} target="_blank" rel="noreferrer" className="pdf-link"><FileText/>打开 {p.name} PDF</a>:<a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.name+"原始答卷"}/></a>}<figcaption>{p.name} · 点击查看原件</figcaption></figure>):<p className="evidence-empty">请关闭此窗口并重新选择原答卷文件夹，即可关联图片和改分，无需 API key。已保存的评分记录仍在。</p>}</div><div className="review-panel"><details className="review-rules"><summary>试题与评分要求<ChevronDown size={14}/></summary><p>{selected.question.text}</p><p>参考答案：{selected.question.solution}</p><p>{job.pack.policies}</p></details>{selected.error&&<div className="rule-warning">{selected.error}</div>}<label className="checkline"><input type="checkbox" checked={hideAI} onChange={e=>setHideAI(e.target.checked)}/>隐藏 AI 建议，独立查看</label>{selected.question.criteria.map((c:AnyData)=><div className="review-criterion" key={c.criterion_id}><div className="criterion-heading"><h4>{c.criterion_id} · {c.description}</h4><select aria-label={c.criterion_id+"改判分数"} value={scores[c.criterion_id]??""} disabled={disabled} onChange={e=>setScores({...scores,[c.criterion_id]:e.target.value})}><option value="">选择分数</option>{c.allowed_scores.map((n:number)=><option key={n} value={n}>{n} 分</option>)}</select></div>{!hideAI&&<div className="dual-reasons">{["A","B"].map(lane=>{const r=selected.results[lane]?.criteria.find((r:AnyData)=>r.criterion_id===c.criterion_id);return <div key={lane}><b>{lane} {r?(r.awarded===null?"待定":r.awarded+" 分"):"暂无结果"}</b><p>{r?.reason}</p>{r&&<small>证据：{r.evidence_refs.join("、")}</small>}</div>;})}</div>}</div>)}<label className="review-field">复核人<input value={reviewer} disabled={disabled} onChange={e=>setReviewer(e.target.value)} placeholder="填写姓名"/></label><label className="review-field">审阅依据 / 改判理由 <small>选填</small><textarea rows={2} value={reason} disabled={disabled} onChange={e=>setReason(e.target.value)} placeholder="可以留空，直接保存改分"/></label><button className="button primary full" disabled={disabled||!selected.inputComplete} onClick={saveReview}><Check size={16}/>保存本题改分</button>{selected.review&&<p className="saved-review">最近改分：{selected.review.reviewer} · {new Date(selected.review.at).toLocaleString()} {selected.review.reason||"（未填写理由）"}</p>}{["error","uncertain"].includes(selected.state)&&<details className="retry-panel"><summary>这道题需要重试？</summary><label className="checkline"><input type="checkbox" checked={retryConsent} onChange={e=>setRetryConsent(e.target.checked)}/>已检查原因，理解重试可能再次计费。</label><button className="button secondary" disabled={disabled} onClick={retrySelected}><RotateCcw size={14}/>重新排队</button></details>}</div></div></section></div>}
  </div>;
}
