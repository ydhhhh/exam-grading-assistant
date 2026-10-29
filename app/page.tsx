"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, FileText, FolderOpen, KeyRound, ArrowRight, Check, ChevronDown, Download, Search, X, Pause, Play, ShieldCheck, RotateCcw, AlertCircle, BookOpen, Eye, EyeOff } from "lucide-react";
import { MODEL, validatePack } from "@/lib/grading/validation.mjs";
import { readUpload, snapshotJob, saveJob, loadJob, restoreBackupSafely, exportCSV, runJob, rebindJob, requeueTask, demoJob, studentPDFDemoJob, DEFAULT_SETTINGS, createStudentPDFJob, reviewTask, attachPreparation, clearLastJob, restorePreparationDraft, documentForTask, studentDisplay, taskAdvice, resolveStudentIdentity, retryStudentIdentity } from "@/lib/grading/browser-workflow.mjs";

import { materializeStudentPDFPage } from "@/lib/grading/student-pdf.mjs";

type AnyData = any;
const defaultSettings = {...DEFAULT_SETTINGS};
const roleLabels: Record<string,string> = { paper: "试题", solution: "参考答案", rubric: "评分细则" };
const stateLabels: Record<string,string> = {ready:"等待批改", input_missing:"缺少材料", running:"正在批改", done:"已生成建议", error:"调用未完成", uncertain:"请求待核查"};
const identityLabels: Record<string,string> = {ready:"身份已关联",pending:"等待识别姓名学号",conflict:"文件名与首页学号冲突",missing_id:"需要补全学号",duplicate:"学号重复",roster_mismatch:"学号不在应收名单",input_error:"PDF需要检查"};
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
  const actionRef = useRef(false);
  const [offline, setOffline] = useState(false);
  const prepRef = useRef<any[]>([]);
  const PREP_KEY = "grading-preparation-v2";
  const jobRef = useRef<AnyData>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const [identityId, setIdentityId] = useState("");
  const [identityStudentId, setIdentityStudentId] = useState("");
  const [identityName, setIdentityName] = useState("");
  const [identityRetryConsent, setIdentityRetryConsent] = useState(false);
  const [coverURL, setCoverURL] = useState("");
  const [originalURL, setOriginalURL] = useState("");
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
    }).catch((e:any)=>setNotice(e.message||"无法恢复浏览器进度，请检查本地存储或备份。"));
  }, []);
  useEffect(() => { const prevent=(e:BeforeUnloadEvent)=>{if(running){e.preventDefault();e.returnValue="";}};window.addEventListener("beforeunload",prevent);return()=>window.removeEventListener("beforeunload",prevent); },[running]);
  useEffect(() => {
    const disconnected=()=>{setOffline(true);if(jobRef.current&&!jobRef.current.demo)setNotice("网络已断开，停止发送新请求；已发出的请求等待返回并保存。结果未定的请求不会自动重发。");};
    const reconnected=()=>{setOffline(false);if(jobRef.current&&!jobRef.current.demo)setNotice("网络已恢复。核对未完成记录后点击继续批改；已保存结果会复用，结果未定的请求仍需单独确认。");};
    setOffline(!navigator.onLine);window.addEventListener("offline",disconnected);window.addEventListener("online",reconnected);
    return()=>{window.removeEventListener("offline",disconnected);window.removeEventListener("online",reconnected);};
  }, []);
  const selected = job?.tasks.find((t:AnyData)=>t.id===selectedId);
  const selectedIdentity = job?.documents?.find((d:AnyData)=>d.id===identityId);
  useEffect(()=>{
    let cancelled=false;const urls:string[]=[];setCoverURL("");setOriginalURL("");
    async function bind(){
      if(selectedIdentity?.file){const u=URL.createObjectURL(selectedIdentity.file);urls.push(u);if(!cancelled)setOriginalURL(u);}
      if(selectedIdentity?.cover?.file){const blob=await materializeStudentPDFPage(selectedIdentity.cover);if(cancelled)return;const u=URL.createObjectURL(blob);urls.push(u);setCoverURL(u);}
    }
    bind().catch(()=>{if(!cancelled)setNotice("身份首页暂时无法打开，请重新选择原PDF文件夹。");});
    return()=>{cancelled=true;urls.forEach(u=>URL.revokeObjectURL(u));};
  },[identityId,answerFiles,job?.id,selectedIdentity?.cover?.file]);
  useEffect(()=>{
    let cancelled=false;const urls:{url:string,name:string,mime:string}[]=[];setPageURLs([]);
    async function bind(){
      if(!selected)return;
      for(const p of selected.pages.filter((p:AnyData)=>p.file)){
        const blob=p.sourcePage?await materializeStudentPDFPage(p):p.file;if(cancelled)return;
        urls.push({url:URL.createObjectURL(blob),name:p.sourcePage?`原PDF第${p.sourcePage}页`:p.page_id,mime:blob.type||(p.path?.endsWith(".pdf")?"application/pdf":"image/jpeg")});
      }
      if(!cancelled)setPageURLs(urls);
    }
    bind().catch(()=>{if(!cancelled)setNotice("本题原页暂时无法打开，请重新选择原PDF文件夹。");});
    return()=>{cancelled=true;urls.forEach(p=>URL.revokeObjectURL(p.url));};
  },[selectedId,answerFiles,job?.id]);

  async function withAction(label:string,fn:()=>Promise<void>){if(actionRef.current)return;actionRef.current=true;setBusy(label);setNotice("");try{await fn();}catch(e:any){setNotice(e.message||"操作未完成，请检查材料后重试。");}finally{actionRef.current=false;setBusy("");}}
  const hasDocuments=Object.values(documents).every(Boolean);
  function persistPrep(){localStorage.setItem(PREP_KEY,JSON.stringify(prepRef.current));}
  async function lockedJob(id:string, fn:()=>Promise<void>){
    if(!navigator.locks)throw Error("请使用新版 Chrome 或 Edge 浏览器，以安全保存和运行批次。");
    await navigator.locks.request("grading-job:"+id,{ifAvailable:true},async lock=>{if(!lock)throw Error("这个批次正在另一个页面运行，请先暂停。");await fn();});
  }
  async function hydrateDemo(saved:AnyData){
    if(saved.demo){const fresh:AnyData=saved.inputMode==="student_pdf"?await studentPDFDemoJob():await demoJob();const files=fresh.inputMode==="student_pdf"?fresh.documents.map((d:AnyData)=>d.file):fresh.tasks.flatMap((t:AnyData)=>t.pages.map((p:AnyData)=>p.file));await rebindJob(saved,files,{load:async()=>null});}
    return saved;
  }
  function keepBoundPages(latest:AnyData,previous:AnyData){
    const bound=new Map(previous.tasks.flatMap((t:AnyData)=>t.pages.map((p:AnyData)=>[p.path,p])));
    for(const t of latest.tasks)for(const p of t.pages){const prev:any=bound.get(p.path);if(prev?.sha256===p.sha256)p.file=prev.file;}
    if(latest.documents){
      const prior=new Map((previous.documents||[]).map((d:AnyData)=>[d.id,d]));
      for(const d of latest.documents){const old:any=prior.get(d.id);if(old?.sha256===d.sha256){d.file=old.file;if(d.cover&&d.cover.sha256===old.cover?.sha256)d.cover.file=old.cover.file;for(const p of d.answerPages||[]){const prev=old.answerPages?.find((x:AnyData)=>x.sha256===p.sha256&&x.path===p.path);if(prev)p.file=prev.file;}}}
    }
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
    if(!navigator.onLine){setNotice("当前网络未连接，请联网后整理评分规则。");return;}
    if(!apiKey.trim()){setNotice("请填写自己的 OpenAI API key。密钥只在本次页面中使用。");keyRef.current?.focus();return;}
    if(!uploadConsent){setNotice("请确认将本次材料发送给 OpenAI 进行处理。");return;}
    await withAction("正在整理评分规则",async()=>{
      if(!navigator.locks)throw Error("请使用新版 Chrome 或 Edge，以防重复提交。");
      await navigator.locks.request("grading-runner",{ifAvailable:true},async lock=>{
      if(!lock)throw Error("另一个页面正在处理请求，请先暂停该页面。");
      const saved=JSON.parse(localStorage.getItem(PREP_KEY)||"[]");if(Array.isArray(saved))prepRef.current=saved;
      const docs=[];
      for(const role of ["paper","solution","rubric"]){const file=documents[role];if(!file)throw Error("请先选择三份教学材料。");docs.push({...await readUpload(file,role+"."+file.name.split(".").pop()),role});}
      const documentHashes=Object.fromEntries(docs.map(d=>[d.role,d.sha256]));
      const reusable=restorePreparationDraft(prepRef.current,{documentHashes});
      if(reusable){setPack(reusable.pack);setPrepareResult(reusable);setPackApproved(false);setNotice("这三份材料已有保存的规则草案，已直接恢复，本次没有再次调用API。请核对后确认。");return;}
      if(prepRef.current.some(a=>a.costCny===null)&&!window.confirm("此前有规则整理请求费用未定，再次提交可能重复计费。确认继续？"))return;
      const committed=prepRef.current.reduce((n,a)=>n+(a.costCny??a.reservedCny),0);
      if(committed+settings.requestReserveCny>settings.budgetCny)throw Error("预算不足以预留这次规则整理请求，请在更多设置核对预算。");
      const requestId=crypto.randomUUID();
      const attempt:any={id:requestId,kind:"prepare",state:"in_flight",reservedCny:settings.requestReserveCny,costCny:null,sentAt:new Date().toISOString()};
      prepRef.current.push(attempt);persistPrep();
      let response:Response,result:any;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),240000);
      try{
        response=await fetch("/api/prepare",{method:"POST",headers:{"Content-Type":"application/json","X-Api-Key":apiKey.trim()},body:JSON.stringify({documents:docs,requestId}),signal:controller.signal});
        result=JSON.parse(JSON.stringify(await response.json()).split(apiKey.trim()).join("[REDACTED]"));
        if(!result||typeof result!=="object"||Array.isArray(result))throw Error("接口返回格式异常");
      }catch{
        attempt.state="uncertain";attempt.uncertain=true;attempt.error="规则整理请求中断，费用未定。";persistPrep();throw Error("规则整理请求中断，可能已计费；再次提交前请核查。原预留已保留。");
      }finally{clearTimeout(timer);}
      attempt.response=result;attempt.usage=result.usage;attempt.requestId=result.requestId;attempt.finishedAt=new Date().toISOString();
      attempt.costCny=typeof result.estimatedCny==="number"&&Number.isFinite(result.estimatedCny)&&result.estimatedCny>=0?result.estimatedCny:(!response.ok&&result.uncertain===false?0:null);
      attempt.state=response.ok?"done":result.uncertain?"uncertain":"error";persistPrep();
      if(!response.ok)throw Error(result.error||"规则识别没有完成。该请求可能已计费，请查看提示。");
      const checked=restorePreparationDraft(prepRef.current);
      if(!checked){attempt.state="error";persistPrep();throw Error("规则结果未通过检查，本次费用记录已保留，请核对后再试。");}
      setPack(checked.pack);setPrepareResult(checked);setPackApproved(false);
      setNotice(result.warnings?.length?"材料中有需要补充的信息，请查看下面的提示，完善后重新整理。":"评分规则已整理。核对题号、满分和评分点后，即可开始批改。");
      });
    });
  }
  async function acceptPack(){
    if(!pack || !packApproved)throw Error("请先核对整理后的评分规则。");
    const approved={...pack,approved_by:pack.approved_by || "上传者已确认评分规则"};validatePack(approved);
    return approved;
  }
  async function start(){
    if(running||busy||actionRef.current)return;
    if(job?.demo){actionRef.current=true;setRunning(true);stopRef.current=false;try{const result=await (runJob as any)(jobRef.current,{apiKey:"",onChange:updateJob,shouldStop:()=>stopRef.current});setNotice(result.reason||(result.paused?"已暂停，返回的结果已保存。":"演示完成，单次评分结果已保存。"));}catch(e:any){setNotice(e.message);}finally{actionRef.current=false;setRunning(false);}return;}
    if(!navigator.onLine){setNotice("网络尚未恢复，已保存的进度可以查看；联网后再继续。");return;}
    if(!apiKey.trim()){setNotice("请填写 API key 后继续。");keyRef.current?.focus();return;}
    if(!uploadConsent){setNotice("请勾选材料发送确认：首页用于姓名、学号识别，作答页按题单独发送。");return;}
    await withAction("正在检查本地答卷",async()=>{
      const approved=await acceptPack();
      if(!answerFiles.length)throw Error("请选择本地答题卡文件夹。");
      let next=jobRef.current;
      if(next){await lockedJob(next.id,async()=>{next=await rebindJob(next,answerFiles);await saveJob(next);});}
      else{
        next=await createStudentPDFJob(approved,answerFiles,settings,roster.split(/\r?\n/).map(s=>s.trim()).filter(Boolean));
        attachPreparation(next,prepRef.current);
        if(next.warnings?.length)setNotice(next.warnings.join("；"));
        await saveJob(next);
      }
      updateJob(next);setPack(approved);
      resultsRef.current?.scrollIntoView({behavior:"smooth"});
      setRunning(true);stopRef.current=false;
      try{const result=await (runJob as any)(next,{apiKey:apiKey.trim(),onChange:updateJob,shouldStop:()=>stopRef.current});setNotice(result.reason||(result.paused?"已暂停，返回的结果已保存。":"本轮处理完成，已保存结果。未完成项目可在下方查看原因。"));}
      finally{setRunning(false);}
    });
  }
  async function loadDemo(){
    if(job&&!window.confirm("当前进度会被新的演示替代。需要保留时请先下载进度备份。继续吗？"))return;
    await withAction("准备演示",async()=>{const next=await studentPDFDemoJob();await saveJob(next);updateJob(next);setPack(next.pack);setPackApproved(true);setApiKey("");setSearch("");setSelectedId("");setNotice("这是每人一份PDF的合成演示，不连接 API。点击“开始演示”查看姓名识别、按页对应题目和建议成绩。");});
  }
  async function reset(){if(!window.confirm("开启新批次会替换本浏览器的当前进度。请先下载进度备份。继续吗？"))return;await clearLastJob();prepRef.current=[];localStorage.removeItem(PREP_KEY);jobRef.current=null;setJob(null);setSelectedId("");setIdentityId("");setPack(null);setPrepareResult(null);setPackApproved(false);setAnswerFiles([]);setApiKey("");setNotice("已开启新批次。上次已下载的备份仍可重新导入。");}
  function backup(){if(job)download("阅卷进度_"+job.id.slice(0,8)+".json",JSON.stringify(snapshotJob(job),null,2));}
  async function loadPack(file:File){await withAction("读取统一规则",async()=>{if(job)throw Error("请先下载当前进度并开启新批次，再更换规则。");const raw=JSON.parse(await file.text());validatePack(raw);if(raw.demo)throw Error("合成规则不能用于真实答卷，请使用真实统一规则。");setPack(raw);setPrepareResult(null);setPackApproved(true);setNotice("已导入统一规则，不需要再次上传试题、答案和细则。");});}
  async function restore(file:File){await withAction("恢复进度",async()=>{if(job&&!window.confirm("用备份替换当前进度？请先下载当前进度以免丢失。"))return;const recovered=await restoreBackupSafely(await file.text());const restored=await hydrateDemo(recovered.job);updateJob(restored);setPack(restored.pack);setPackApproved(true);setSettings({...defaultSettings,...restored.settings});setAnswerFiles([]);setSelectedId("");setNotice(recovered.usedLocal?"本机已有该批次的进度，已恢复本机记录；没有用上传备份覆盖，以免重复提交。":restored.demo?"演示备份及原图已恢复，可直接查看或改分。":"备份已恢复。重新选择原答卷文件夹即可查看和改分；继续批改时再填写密钥。");});}
  function chooseTask(t:AnyData){setIdentityId("");setSelectedId(t.id);const current=taskAdvice(job,t);setScores(Object.fromEntries(t.question.criteria.map((c:AnyData)=>[c.criterion_id,current.scores?.[c.criterion_id]?.toString()??""])));setReason("");setRetryConsent(false);}
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

  async function checkPDFs(){await withAction("正在检查PDF页数",async()=>{
    if(jobRef.current)throw Error("当前已有批次，请先备份后开启新批次。");
    const approved=await acceptPack();if(!answerFiles.length)throw Error("请先选择答题卡PDF文件夹。");
    const next=await createStudentPDFJob(approved,answerFiles,settings,roster.split(/\r?\n/).map(s=>s.trim()).filter(Boolean));
    attachPreparation(next,prepRef.current);await saveJob(next);updateJob(next);setPack(approved);
    setNotice("PDF已在本机检查，尚未调用API。可查看下方收件清单；填写密钥并开始后识别姓名学号及批改。");
  });}
  function chooseIdentity(d:AnyData){setSelectedId("");setIdentityId(d.id);setIdentityStudentId(d.studentId||d.filenameStudentId||d.identityResult?.student_id||"");setIdentityName(d.identityReview ? d.identityReview.name ?? "" : d.name||d.identityResult?.name||"");setIdentityRetryConsent(false);}
  async function saveIdentity(){await withAction("保存姓名学号",async()=>{
    if(!selectedIdentity)return;
    await lockedJob(jobRef.current.id,async()=>{const latest=keepBoundPages(await loadJob(jobRef.current.id)||jobRef.current,jobRef.current);resolveStudentIdentity(latest,identityId,{studentId:identityStudentId.trim(),name:identityName.trim()});await saveJob(latest);updateJob(latest);});
    setNotice("姓名学号已保存。是否存在重复或名单冲突已重新检查；后续导出采用当前信息。");
  });}
  async function retryIdentity(){await withAction("重新排队识别",async()=>{
    if(!selectedIdentity)return;
    await lockedJob(jobRef.current.id,async()=>{const latest=keepBoundPages(await loadJob(jobRef.current.id)||jobRef.current,jobRef.current);retryStudentIdentity(latest,identityId,identityRetryConsent);await saveJob(latest);updateJob(latest);});
    setNotice("首页识别已重新排队，点击继续批改后重试。");
  });}

  const disabled=!!busy||running;
  const tasks:AnyData[]=job?.tasks||[];
  const summaries=tasks.map(t=>({...t,advice:taskAdvice(job,t),display:studentDisplay(job,t)}));
  const filtered=summaries.filter(t=>[t.display.studentId,t.display.name,t.display.document?.path].some(v=>String(v||"").toLowerCase().includes(search.trim().toLowerCase())));
  const filteredDocuments=(job?.documents||[]).filter((d:AnyData)=>[d.studentId,d.name,d.path,d.filenameStudentId].some(v=>String(v||"").toLowerCase().includes(search.trim().toLowerCase())));
  const completed=summaries.filter(t=>t.advice.total!==null).length;
  const activeRequests=tasks.filter(t=>t.state==="running").length+(job?.documents||[]).filter((d:AnyData)=>d.identityState==="running").length;
  const reviewCount=tasks.filter(t=>t.review).length;
  const studentIds=Array.from(new Set(filtered.map(t=>t.studentId)));
  const oneStudent=studentIds.length===1?studentIds[0]:null;
  const oneStudentLabel=oneStudent?(filtered[0]?.display.studentId||filtered[0]?.display.document?.path||oneStudent):null;
  const studentTasks=oneStudent?summaries.filter(t=>t.studentId===oneStudent):[];
  const studentTotal=studentTasks.length&&studentTasks.every(t=>t.advice.total!==null)?Math.round(studentTasks.reduce((s,t)=>s+t.advice.total,0)*10000)/10000:null;

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/"><span className="brand-icon"><BookOpen size={22}/></span><span>阅卷助手<small>统一标准 · 自动建议 · 按需复核</small></span></a><div className="header-actions"><span className="tag"><ShieldCheck size={14}/>各自密钥 · 本机进度</span><button className="text-button" onClick={loadDemo} disabled={disabled}>先体验演示 <ArrowRight size={15}/></button></div></header>
    <main>
      <section className="intro"><div><span className="eyebrow">给助教的一张工作台</span><h1>把材料放进来，<br className="mobile-break"/>让批改简单一点。</h1><p>上传统一材料，选择答卷文件夹，等待建议成绩。需要时，再按学号复核。</p></div><div className="intro-note"><span>01 准备材料</span><ArrowRight size={16}/><span>02 自动批改</span><ArrowRight size={16}/><span>03 导出成绩</span></div></section>
      {offline&&<div className="message" role="status"><AlertCircle size={18}/><span>当前离线 · 可查看已保存进度，联网后手动继续。</span></div>}
      {notice&&<div className="message" role="status"><AlertCircle size={18}/><span>{notice}</span><button aria-label="关闭提示" onClick={()=>setNotice("")}><X size={16}/></button></div>}
      {job?.demo&&<div className="demo-banner">当前为合成演示 · 不调用 API · 演示分数不代表真实评分效果 <button onClick={reset} disabled={disabled}>切换到真实批次</button></div>}
      <section className="workspace-card">
        <div className="section-title"><div><h2>准备本次批改</h2><p>只需这些材料。技术设置已经收好。</p></div><div className="quiet-links"><label className="file-link">导入统一规则<input type="file" accept=".json" disabled={disabled||!!job} onChange={e=>e.target.files?.[0]&&loadPack(e.target.files[0])}/></label><label className="file-link">恢复进度<input type="file" accept=".json" disabled={disabled} onChange={e=>e.target.files?.[0]&&restore(e.target.files[0])}/></label>{job&&<button className="text-button" onClick={reset} disabled={disabled}>新批次</button>}</div></div>
        {packApproved&&pack&&!job?.demo?<div className="pack-ready"><Check size={18}/><span>已采用统一规则：{pack.title} · {pack.questions.length} 题 · {pack.questions.reduce((a:number,q:AnyData)=>a+q.max_score,0)} 分</span>{!job&&<button className="text-button" disabled={disabled} onClick={()=>{setPack(null);setPackApproved(false);setPrepareResult(null);}}>重新选择材料</button>}</div>:<div className="document-grid">{["paper","solution","rubric"].map((role,index)=><label className={"upload-tile "+(documents[role]?"has-file":"")} key={role}><span className="tile-number">0{index+1}</span><FileText size={25} strokeWidth={1.5}/><strong>{roleLabels[role]}</strong><span className="upload-name">{documents[role]?.name||"点击选择文件"}</span><small>PDF / Word / 图片 / 文本 · ≤3 MiB</small><input type="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp" disabled={disabled||!!job} onChange={e=>{setDocuments({...documents,[role]:e.target.files?.[0]||null});setPack(null);setPackApproved(false);setPrepareResult(null);}}/></label>)}</div>}
        <div className="input-grid"><div className="folder-section"><label className={"folder-box "+(answerFiles.length?"has-file":"")}><span className="input-icon"><FolderOpen size={24}/></span><span><strong>本地答题卡文件夹</strong><small>{answerFiles.length?`已选择 ${answerFiles.length} 个文件` : "每位同学一份 学号.pdf，保留身份首页"}</small></span><span className="select-button">选择文件夹</span><input type="file" accept=".pdf" multiple {...({webkitdirectory:"",directory:""} as any)} disabled={disabled||job?.demo} onChange={e=>chooseAnswerFolder(Array.from(e.target.files||[]))}/></label><details className="folder-help"><summary>文件夹怎么放？<ChevronDown size={13}/></summary><p>每位同学一份扫描 PDF，命名为 <code>2026000001.pdf</code>。若有 m 道题，每份必须有 m＋1 页：第1页是姓名、学号等信息；第2页到第m＋1页依次对应第1题到第m题。无需手动拆分。</p><p>漏改文件名时尝试从首页补识别学号；身份冲突、重复学号和页数不符会单独提示。姓名读不清时留空，可手动更正。整份PDF最大64 MiB，拆出的每页最大3 MiB。完全漏收的学生需通过“更多设置”中的名单检查。</p></details>{packApproved&&answerFiles.length>0&&!job&&<button className="text-button" disabled={disabled} onClick={checkPDFs}>先检查PDF页数（不调用API）</button>}</div><div className="key-section"><label htmlFor="api-key"><KeyRound size={17}/>你的 OpenAI API key</label><div className="key-input"><input id="api-key" ref={keyRef} type={showKey?"text":"password"} autoComplete="off" spellCheck={false} placeholder="填写自己的密钥" value={apiKey} disabled={disabled} onChange={e=>setApiKey(e.target.value)}/><button aria-label={showKey?"隐藏密钥":"显示密钥"} onClick={()=>setShowKey(!showKey)} type="button">{showKey?<EyeOff size={17}/>:<Eye size={17}/>}</button></div><small>只在本次页面使用，不写进进度、导出文件或公开网页。</small></div></div>
        <details className="advanced"><summary>更多设置与费用 <ChevronDown size={14}/></summary><div className="advanced-body"><p>默认使用 {MODEL}，每份PDF先识别一次首页，每题只批改一次。默认同时处理4个请求，每次完成后保存并补上下一项；不是本课程已验收模型。费用根据当前用量估算，以服务商账单为准。</p><div className="advanced-grid"><label>本批预算（元）<input type="number" min="5" max="5000" value={settings.budgetCny} disabled={!!job||disabled} onChange={e=>setSettings({...settings,budgetCny:Number(e.target.value)})}/></label><label>同时处理的请求数<select value={settings.concurrency} disabled={!!job||disabled} onChange={e=>setSettings({...settings,concurrency:Number(e.target.value)})}>{[1,2,4].map(n=><option key={n} value={n}>{n} 个</option>)}</select></label><label>单次费用预留（元）<input type="number" min="1" max="100" value={settings.requestReserveCny} disabled={!!job||disabled} onChange={e=>setSettings({...settings,requestReserveCny:Number(e.target.value)})}/></label></div><label className="roster-label">应收学号名单（选填，每行一个；可发现完全漏交的同学）<textarea rows={3} value={roster} disabled={!!job||disabled} onChange={e=>setRoster(e.target.value)} placeholder="2026001&#10;2026002"/></label><p>请求发出前先保存记录并预留费用，预算同时计入已用费用、所有在途请求和费用未定的预留。额度不足时减少实际并发或暂停。共享 API 项目的助教可能共享限额；限流或断网后停止补发，等待在途结果保存，不自动重试可能已计费的调用。人民币换算暂按7.5作预算系数，不是实时汇率。</p></div></details>
        {pack&&<div className="rule-preview"><div className="rule-heading"><h3>{pack.title || "评分规则预览"}</h3><span>{pack.questions.length} 题 · {pack.questions.reduce((s:number,q:AnyData)=>s+q.max_score,0)} 分</span></div>{prepareResult?.warnings?.length>0&&<div className="rule-warning">{prepareResult.warnings.map((w:string,i:number)=><p key={i}>{w}</p>)}</div>}<div className="question-chips">{pack.questions.map((q:AnyData)=><details key={q.question_id}><summary>{q.question_id}<b>{q.max_score} 分</b><ChevronDown size={13}/></summary><div><p>{q.text}</p><p>参考答案：{q.solution}</p>{q.criteria.map((c:AnyData)=><p key={c.criterion_id}><strong>{c.criterion_id}：</strong>{c.description}<br/><small>允许分值：{c.allowed_scores.join(" / ")}</small></p>)}</div></details>)}</div><details className="review-rules"><summary>评分政策<ChevronDown size={14}/></summary><p>{pack.policies}</p></details>{!packApproved&&!job&&<label className="checkline"><input type="checkbox" checked={packApproved} disabled={!!prepareResult?.warnings?.length} onChange={e=>setPackApproved(e.target.checked)}/>我已核对题号、满分和评分点与教师要求一致。</label>}<button className="text-button" disabled={!packApproved||disabled} onClick={async()=>{try{const p=await acceptPack();download("统一评分规则.json",JSON.stringify(p,null,2));}catch(e:any){setNotice(e.message);}}}><Download size={14}/>下载统一规则，供其他助教直接导入</button></div>}
        {!job?.demo&&<label className="checkline upload-consent"><input type="checkbox" checked={uploadConsent} onChange={e=>setUploadConsent(e.target.checked)} disabled={disabled}/>我确认将材料发送给 OpenAI：身份首页用于姓名、学号识别，作答页分别用于评分，并理解会产生 API 费用。</label>}
        <div className="start-row"><p><ShieldCheck size={16}/>{job?.demo?"演示不需要密钥，也不会联网批改":"PDF本地拆页，身份与评分分别发送 · 不存入网站数据库"}</p>{running?<button className="button primary" onClick={()=>{stopRef.current=true;setNotice("已停止补发；等待所有在途请求完成并保存，请先保持页面打开。");}}><Pause size={17}/>暂停批改</button>:<button className="button primary" disabled={!!busy||(!pack&&!hasDocuments)} onClick={pack?start:prepareRules}>{busy?<span className="spinner"/>:job?.demo?<Play size={17}/>:<ArrowRight size={17}/>} {busy||(!pack?"整理评分规则":job?.demo?"开始演示":job?"继续批改":"开始批改")}</button>}</div>
      </section>
      <section className="results-section" ref={resultsRef}><div className="section-title"><div><h2>建议成绩与可选复核</h2><p>批改完成即可导出。想查看哪位同学，输入学号就好。</p></div>{job&&<div className="quiet-links"><button className="text-button" onClick={backup} disabled={disabled}><Download size={15}/>进度备份</button><button className="button secondary" onClick={()=>download("AI建议成绩.csv",exportCSV(job),"text/csv;charset=utf-8")}><Download size={16}/>导出建议成绩</button></div>}</div>{!job?<div className="empty-state"><span><FileText size={32} strokeWidth={1.2}/></span><h3>成绩会出现在这里</h3><p>准备好材料后开始批改，或先体验无需密钥的演示。</p></div>:<><div className="stats-row"><div><span>本批任务</span><strong>{tasks.length}<small>题</small></strong></div><div><span>已生成建议</span><strong>{completed}<small>题</small></strong></div><div><span>人工改分 · 可选</span><strong>{reviewCount}<small>题</small></strong></div><div><span>费用估算 + 未决预留</span><strong className="cost">{money((job.spentCny||0)+(job.heldCny||0))}<small>/ {money(job.settings.budgetCny)}</small></strong></div></div><div className="progress"><i style={{width:`${tasks.length?100*completed/tasks.length:0}%`}}/></div><div className="result-toolbar"><div className="search-box"><Search size={18}/><input aria-label="按学号搜索" value={search} onChange={e=>setSearch(e.target.value)} placeholder="输入学号、姓名或文件名查找"/></div><span>{running?`同时处理 ${activeRequests} / ${job.settings.concurrency} 个请求 · 每次完成后保存`:oneStudent?`${oneStudentLabel} · 建议总分 ${studentTotal===null?"未完成":studentTotal}`:"进度保存在此浏览器，可随时下载备份"}</span></div>{job.inputMode==="student_pdf"&&<details className="pdf-collection" open><summary>PDF收件与姓名识别 <span>{job.documents.length} 份</span></summary><p>首页单独识别姓名、学号；姓名读不清不猜填。身份冲突或页数异常的答卷会暂留未完成，其余可以继续。</p><div className="table-scroll"><table><thead><tr><th>原PDF文件</th><th>页数</th><th>学号</th><th>姓名</th><th>状态</th><th></th></tr></thead><tbody>{filteredDocuments.slice(0,200).map((d:AnyData)=><tr key={d.id}><td className="pdf-filename">{d.path}</td><td>{d.pageCount??"—"} / {d.expectedPageCount||job.pack.questions.length+1}</td><td>{d.studentId||d.filenameStudentId||"待补学号"}</td><td>{d.name||"—"}<small className="name-source">{d.nameSource==="manual"?"人工更正":d.name?"手写识别":""}</small></td><td><span className={"state "+(d.mappingStatus==="ready"?"complete":"")}>{["error","uncertain"].includes(d.identityState)?"识别未完成":identityLabels[d.mappingStatus]||d.mappingStatus}</span>{d.inputError&&<small className="document-error">{d.inputError}</small>}{d.identityError&&<small className="document-error">{d.identityError}</small>}{!d.inputError&&d.identityWarnings?.length>0&&<small className="document-error">{d.identityWarnings.join("；")}</small>}</td><td><button className="text-button" disabled={disabled} onClick={()=>chooseIdentity(d)}>查看 / 更正</button></td></tr>)}</tbody></table></div>{filteredDocuments.length>200&&<p>显示前200份，输入学号、姓名或文件名可筛选。</p>}</details>}
        <div className="table-scroll"><table><thead><tr><th>学号</th><th>姓名</th><th>题号</th><th>建议分</th><th>状态</th><th>分数来源</th><th></th></tr></thead><tbody>{filtered.slice(0,200).map(t=><tr key={t.id}><td className="student-cell">{t.display.studentId||"待补学号"}</td><td>{t.display.name||"—"}</td><td>{t.questionId}</td><td className="score-cell">{t.advice.total===null?"—":t.advice.total}<small> / {t.question.max_score}</small></td><td><span className={"state "+(t.advice.total!==null?"complete":"")}>{t.display.document&&t.display.status!=="ready"?(identityLabels[t.display.status]||t.display.status):t.review?"已人工改分":t.result?.status==="needs_review"?"评分有待定项":stateLabels[t.state]||t.state}</span></td><td>{t.advice.source==="human"?"人工改分":t.advice.source==="ai"?"AI建议":"待定"}</td><td><button className="text-button" onClick={()=>chooseTask(t)}>查看 / 改分 <ArrowRight size={14}/></button></td></tr>)}</tbody></table>{filtered.length>200&&<p className="table-note">目前显示前200题，输入学号可定位其余结果。</p>}{!filtered.length&&<p className="table-note">没有找到这个学号。</p>}</div><p className="results-note">每题一次AI评分，人工改分优先。缺页、读不清和调用失败不按零分处理，未完成题目使总分留空。自动结果是建议成绩，正式用途仍需教师确认。</p></>}</section>
      <footer><span>阅卷助手 · 网页版</span><p>无需安装 · 密钥仅用于本次会话 · 页面关闭后不会继续后台批改</p><a href="https://developers.openai.com/api/docs/models/gpt-6.1-terra" target="_blank" rel="noreferrer">模型与费用说明 ↗</a></footer>
    </main>
    {selectedIdentity&&<div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)setIdentityId("");}}><section className="review-modal identity-modal" role="dialog" aria-modal="true" aria-label="查看与更正姓名学号"><div className="modal-header"><div><span className="eyebrow">姓名与学号</span><h2>{selectedIdentity.path}</h2></div><button className="icon-button" aria-label="关闭身份核对" onClick={()=>setIdentityId("")}><X size={22}/></button></div><div className="review-columns"><div className="evidence-panel"><h3>原PDF身份首页</h3>{coverURL?<a href={coverURL} target="_blank" rel="noreferrer" className="pdf-link"><FileText/>打开首页 PDF</a>:<p className="evidence-empty">重新选择原答卷文件夹后可打开首页核对。</p>}{originalURL&&<a className="text-button" href={originalURL} target="_blank" rel="noreferrer">打开完整原始PDF（仅在本机查看）</a>}<p className="results-note">系统只提取学生姓名和学号，忽略授课教师、分数表及考试纪律。</p></div><div className="review-panel">{selectedIdentity.inputError&&<div className="rule-warning">{selectedIdentity.inputError}</div>}{selectedIdentity.identityError&&<div className="rule-warning">{selectedIdentity.identityError}</div>}<p>文件名学号：{selectedIdentity.filenameStudentId||"未按学号命名"}<br/>首页识别学号：{selectedIdentity.identityResult?.student_id||"未识别或读不清"}<br/>首页识别姓名：{selectedIdentity.identityResult?.name||"未识别或读不清"}</p><label className="review-field">学号<input inputMode="numeric" value={identityStudentId} onChange={e=>setIdentityStudentId(e.target.value)} disabled={disabled} placeholder="核对首页后填写，保留开头的0"/></label><label className="review-field">姓名 <small>读不清可留空</small><input value={identityName} onChange={e=>setIdentityName(e.target.value)} disabled={disabled}/></label><button className="button primary full" onClick={saveIdentity} disabled={disabled||!selectedIdentity.cover?.file}><Check size={16}/>保存姓名学号</button><p className="results-note">无需填写理由；保存会记录这次人工更正。重复学号仍需处理，页数问题需修复原PDF后开启新批次。</p>{["error","uncertain"].includes(selectedIdentity.identityState)&&<details className="retry-panel"><summary>重新识别首页</summary><label className="checkline"><input type="checkbox" checked={identityRetryConsent} onChange={e=>setIdentityRetryConsent(e.target.checked)}/>已检查原因，理解重试可能再次计费。</label><button className="button secondary" disabled={disabled} onClick={retryIdentity}><RotateCcw size={14}/>重新排队识别</button></details>}</div></div></section></div>}
    {selected&&<div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)setSelectedId("");}}><section className="review-modal" role="dialog" aria-modal="true" aria-label="可选人工复核"><div className="modal-header"><div><span className="eyebrow">可选人工复核</span><h2>{studentDisplay(job,selected).studentId||"待补学号"} {studentDisplay(job,selected).name||""} <small>· {selected.questionId}</small></h2></div><button className="icon-button" aria-label="关闭复核" onClick={()=>setSelectedId("")}><X size={22}/></button></div><div className="review-columns"><div className="evidence-panel"><h3>{job?.inputMode==="student_pdf"?"本题对应的PDF页面":"原图与续页"}</h3>{pageURLs.length?pageURLs.map(p=><figure key={p.name}>{p.mime==="application/pdf"?<a href={p.url} target="_blank" rel="noreferrer" className="pdf-link"><FileText/>打开 {p.name} PDF</a>:<a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.name+"原始答卷"}/></a>}<figcaption>{p.name} · 点击查看原件</figcaption></figure>):<p className="evidence-empty">请关闭此窗口并重新选择原答卷文件夹，即可关联图片和改分，无需 API key。已保存的评分记录仍在。</p>}</div><div className="review-panel"><details className="review-rules"><summary>试题与评分要求<ChevronDown size={14}/></summary><p>{selected.question.text}</p><p>参考答案：{selected.question.solution}</p><p>{job.pack.policies}</p></details>{selected.error&&<div className="rule-warning">{selected.error}</div>}<label className="checkline"><input type="checkbox" checked={hideAI} onChange={e=>setHideAI(e.target.checked)}/>隐藏 AI 建议，独立查看</label>{selected.question.criteria.map((c:AnyData)=><div className="review-criterion" key={c.criterion_id}><div className="criterion-heading"><h4>{c.criterion_id} · {c.description}</h4><select aria-label={c.criterion_id+"改判分数"} value={scores[c.criterion_id]??""} disabled={disabled} onChange={e=>setScores({...scores,[c.criterion_id]:e.target.value})}><option value="">选择分数</option>{c.allowed_scores.map((n:number)=><option key={n} value={n}>{n} 分</option>)}</select></div>{!hideAI&&<div className="grading-reason">{(()=>{const r=selected.result?.criteria.find((r:AnyData)=>r.criterion_id===c.criterion_id);return <div><b>AI建议 · {r?(r.awarded===null?"待定":r.awarded+" 分"):"暂无结果"}</b><p>{r?.reason}</p>{r&&<small>证据：{r.evidence_refs.join("、")}</small>}</div>;})()}</div>}</div>)}<label className="review-field">复核人<input value={reviewer} disabled={disabled} onChange={e=>setReviewer(e.target.value)} placeholder="填写姓名"/></label><label className="review-field">审阅依据 / 改判理由 <small>选填</small><textarea rows={2} value={reason} disabled={disabled} onChange={e=>setReason(e.target.value)} placeholder="可以留空，直接保存改分"/></label><button className="button primary full" disabled={disabled||!selected.inputComplete||(job?.inputMode==="student_pdf"&&studentDisplay(job,selected).status!=="ready")} onClick={saveReview}><Check size={16}/>保存本题改分</button>{selected.review&&<p className="saved-review">最近改分：{selected.review.reviewer} · {new Date(selected.review.at).toLocaleString()} {selected.review.reason||"（未填写理由）"}</p>}{["error","uncertain"].includes(selected.state)&&<details className="retry-panel"><summary>这道题需要重试？</summary><label className="checkline"><input type="checkbox" checked={retryConsent} onChange={e=>setRetryConsent(e.target.checked)}/>已检查原因，理解重试可能再次计费。</label><button className="button secondary" disabled={disabled} onClick={retrySelected}><RotateCcw size={14}/>重新排队</button></details>}</div></div></section></div>}
  </div>;
}
