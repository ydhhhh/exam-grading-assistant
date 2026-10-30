"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, FileText, FolderOpen, KeyRound, ArrowRight, Check, ChevronDown, Download, Search, X, Pause, Play, ShieldCheck, RotateCcw, AlertCircle, BookOpen, Eye, EyeOff } from "lucide-react";
import { validatePack } from "@/lib/grading/validation.mjs";
import { prepareTeachingMaterials, snapshotJob, saveJob, loadJob, restoreSessionBackup, exportCSV, runJob, rebindJob, requeueTask, demoJob, studentPDFDemoJob, DEFAULT_SETTINGS, ANSWER_TRANSPORT_VERSION, createStudentPDFJob, reviewTask, attachPreparation, clearLastJob, restorePreparationDraft, reviewPreparationDraft, documentForTask, studentDisplay, taskAdvice, resolveStudentIdentity, retryStudentIdentity } from "@/lib/grading/browser-workflow.mjs";

import { materializeStudentPDFPage } from "@/lib/grading/student-pdf.mjs";
import { getProvider, getDefaultProfile, DEFAULT_STAGE_PROFILES, validateStageProfiles, stageProfilesEqual } from "@/lib/grading/providers.mjs";
import PDFPreview from "./PDFPreview";
import {IS_GITHUB_PAGES,publicPath,storageName,deploymentFetch,assertDeploymentCanRun,MANAGED_BACKUP_NOTICE} from "@/lib/grading/browser-deployment.mjs";
import { profilesEqual } from "@/lib/grading/review-profile.mjs";
import ServiceAccess from "./ServiceAccess";
import StageConfiguration from "./StageConfiguration";
import PreparationReview from "./PreparationReview";
import { ModelReviewSummary, ModelReviewCriterion, modelReviewLabels, InstructionConcern } from "./ModelReview";
import { computeReviewComparison } from "@/lib/grading/review-comparison.mjs";
import ReviewDialog from "./ReviewDialog";
import { TeachingMaterialUpload, AnswerFileUpload } from "./UploadControls";
import { RESULT_FILTERS, filterResults, filterDocuments, countResultFilters, countDocumentFilters, paginate, getTaskFlags, hasUncertainCost } from "@/lib/grading/result-filters.mjs";

type AnyData = any;
const defaultSettings = {...DEFAULT_SETTINGS};
const settingsWithStages=(previous:any,stageProfiles:any)=>({...previous,stageProfiles,provider:stageProfiles.grade.provider,reasoning:stageProfiles.grade.reasoning,outputTokens:stageProfiles.grade.outputTokens,reviewProfile:stageProfiles.review});
const roleLabels: Record<string,string> = { paper: "试题", solution: "参考答案", rubric: "评分细则" };
const stateLabels: Record<string,string> = {ready:"等待批改", input_missing:"缺少材料", running:"正在批改", done:"已生成建议", error:"调用未完成", uncertain:"请求待核查"};
const identityLabels: Record<string,string> = {ready:"身份已关联",pending:"等待识别姓名学号",conflict:"文件名与首页学号冲突",missing_id:"需要补全学号",duplicate:"学号重复",roster_mismatch:"学号不在应收名单",input_error:"PDF需要检查"};
const money = (v: number) => `¥${Number(v || 0).toFixed(2)}`;
function unadoptedResult(task:AnyData){
  if(!task||task.result||!['error','uncertain'].includes(task.state))return null;
  try{
    const attempt=task.attempts?.findLast((a:AnyData)=>a.response?.raw);
    const raw=JSON.parse(attempt.response.raw);
    const text=typeof raw.choices?.[0]?.message?.content==='string'?raw.choices[0].message.content:(raw.output||[]).flatMap((o:AnyData)=>(o.content||[]).filter((c:AnyData)=>c.type==='output_text').map((c:AnyData)=>c.text)).join('\n');
    const result=JSON.parse(text);
    return result?.question_id===task.questionId&&Array.isArray(result.criteria)?result:null;
  }catch{return null;}
}
function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function Pagination({label,data,onChange}:{label:string,data:AnyData,onChange:(page:number)=>void}){
  return <nav className="pagination" aria-label={`${label}分页`}>
    <span role="status">{data.total?`显示 ${data.start}–${data.end} / ${data.total} ${label==="题目"?"题":"份"}`:"共 0 项"}</span>
    {data.pageCount>1&&<div><button type="button" disabled={data.page<=1} onClick={()=>onChange(data.page-1)}>上一页</button><span>第 {data.page} / {data.pageCount} 页</span><button type="button" disabled={data.page>=data.pageCount} onClick={()=>onChange(data.page+1)}>下一页</button></div>}
  </nav>;
}
function ModalMessage({feedback}:{feedback:{kind:"error"|"success",text:string}|null}){
  return feedback?<div className={`modal-feedback ${feedback.kind}`} role={feedback.kind==="error"?"alert":"status"} aria-atomic="true">{feedback.kind==="error"?<AlertCircle size={18}/>:<Check size={18}/>}<span>{feedback.text}</span></div>:null;
}
async function serviceRequest(path:string,options:RequestInit={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await deploymentFetch(path,{...options,credentials:"same-origin",cache:"no-store",signal:controller.signal});
    const body:any=await response.json();return {response,body};
  }catch(error){
    if(controller.signal.aborted)throw Error("服务连接超时，请检查网络后重试。尚未提交评分请求。");
    throw error;
  }finally{clearTimeout(timer);}
}

export default function Home() {
  const [documents, setDocuments] = useState<Record<string,File|null>>({paper:null, solution:null, rubric:null});
  const [answerFiles, setAnswerFiles] = useState<File[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [prepareApiKey,setPrepareApiKey] = useState("");
  const [reviewApiKey, setReviewApiKey] = useState("");
  const [runtimeConfig, setRuntimeConfig] = useState<AnyData>(null);
  const [configError, setConfigError] = useState("");
  const [restored, setRestored] = useState(false);
  const [pack, setPack] = useState<AnyData>(null);
  const [packApproved, setPackApproved] = useState(false);
  const [prepareResult, setPrepareResult] = useState<AnyData>(null);
  const [preparationDirty, setPreparationDirty] = useState(false);
  const [job, setJob] = useState<AnyData>(null);
  const [settings, setSettings] = useState<any>(defaultSettings);
  const provider = getProvider(settings.provider);
  const prepareProfile=settings.stageProfiles.prepare;
  const prepareProvider=getProvider(prepareProfile.provider);
  const stageKeys={prepare:prepareApiKey,grade:apiKey,review:reviewApiKey};
  const [busy, setBusy] = useState("");
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<AnyData>(null);
  const [notice, setNotice] = useState("");
  const [modalFeedback, setModalFeedback] = useState<{kind:"error"|"success",text:string}|null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [reviewErrors, setReviewErrors] = useState<Record<string,string>>({});
  const [identityError, setIdentityError] = useState("");
  const [reviewDirty, setReviewDirty] = useState(false);
  const [touchedScores, setTouchedScores] = useState<Record<string,boolean>>({});
  const [identityDirty, setIdentityDirty] = useState(false);
  const [resultFilter, setResultFilter] = useState("all");
  const [resultPage, setResultPage] = useState(1);
  const [documentPage, setDocumentPage] = useState(1);
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
  const PREP_KEY = storageName("grading-domestic-preparation-v1");
  const jobRef = useRef<AnyData>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const reviewerRef = useRef<HTMLInputElement>(null);
  const identityInputRef = useRef<HTMLInputElement>(null);
  const scoreRefs = useRef<Record<string,HTMLSelectElement|null>>({});
  const [identityId, setIdentityId] = useState("");
  const [identityStudentId, setIdentityStudentId] = useState("");
  const [identityName, setIdentityName] = useState("");
  const [identityRetryConsent, setIdentityRetryConsent] = useState(false);
  const [coverPreview, setCoverPreview] = useState<{id:string,file:Blob}|null>(null);
  const [originalURL, setOriginalURL] = useState("");
  const [pageURLs, setPageURLs] = useState<{id:string,file:Blob,url:string,name:string,mime:string}[]>([]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState("");

  const updateJob = (next: AnyData) => { jobRef.current=next; setJob({...next, tasks:[...next.tasks]}); };
  useEffect(() => {
    try{const saved=JSON.parse(localStorage.getItem(PREP_KEY)||"[]");if(Array.isArray(saved))prepRef.current=saved;}catch{}
    const draft=restorePreparationDraft(prepRef.current);
    const savedProfiles=prepRef.current.at(-1)?.stageProfiles;
    if(savedProfiles){try{validateStageProfiles(savedProfiles);setSettings((previous:any)=>settingsWithStages(previous,savedProfiles));}catch{setNotice("保存的阶段模型配置无效，请先保留备份并开启新批次。");}}
    loadJob().then(async(saved:AnyData)=>{
      if(saved){
        await hydrateDemo(saved);updateJob(saved);setPack(saved.pack);setPackApproved(true);setSettings({...defaultSettings,...saved.settings});
        setNotice(IS_GITHUB_PAGES&&!saved.demo&&saved.settings.credentialMode==="managed"?MANAGED_BACKUP_NOTICE:saved.demo?"演示进度和原图已恢复，可继续查看或改分，无需密钥。":IS_GITHUB_PAGES?"已恢复本浏览器的进度。重新选择原答卷文件夹即可查看和改分；继续批改前请重新填写各步骤的个人密钥。":"已恢复本浏览器的进度。重新选择原答卷文件夹即可查看原图和改分；继续运行时需验证服务权限或填写测试密钥。");
      }else if(draft){
        setPack(draft.pack);setPrepareResult(draft);setPackApproved(false);
        setNotice(!draft.ready?"已恢复规则草案。请逐项核对待处理问题，可在下方修正规则并记录处理依据，无需重复调用 API。":"已恢复上次整理的规则草案，无需重复调用 API。请重新核对题号、满分和评分点后确认。");
      }
    }).catch((e:any)=>setNotice(e.message||"无法恢复浏览器进度，请检查本地存储或备份。")).finally(()=>setRestored(true));
  }, []);
  async function refreshService(){
    const {response,body:config}=await serviceRequest("/api/runtime-config");
    if(!response.ok)throw Error("无法读取批改服务配置，请刷新后重试。");
    if(!config||!["test","managed","unconfigured"].includes(config.mode))throw Error("批改服务配置无效。");
    setRuntimeConfig(config);setConfigError("");return config;
  }
  useEffect(()=>{refreshService().catch(e=>setConfigError(e.message));},[]);
  useEffect(()=>{
    if(!restored||!runtimeConfig||jobRef.current)return;
    setSettings((previous:any)=>{
      const stages=runtimeConfig.mode==="managed"&&runtimeConfig.stageProfiles?runtimeConfig.stageProfiles:previous.stageProfiles;
      return {...settingsWithStages(previous,stages),credentialMode:runtimeConfig.mode==="managed"?"managed":"test"};
    });
  },[restored,runtimeConfig,job?.id]);
  async function authenticate(code:string){
    return withAction("正在验证访问权限",async()=>{
      const {response,body:result}=await serviceRequest("/api/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accessCode:code})});
      if(!response.ok)throw Error(result.error||"访问码验证失败。");
      await refreshService();setNotice("访问权限已验证，可以开始批改，无需填写 API key。");
    });
  }
  async function signOut(){await withAction("正在退出",async()=>{
    const {response}=await serviceRequest("/api/session",{method:"DELETE"});
    if(!response.ok)throw Error("退出未完成，请重试。");
    await refreshService();setNotice("已退出服务使用权限，本浏览器保存的进度仍可查看。");
  });}
  async function ensureService(forGrading=false){
    const config=await refreshService();
    assertDeploymentCanRun({demo:job?.demo,settings});
    if(!config.ready)throw Error(config.message||"服务尚未配置完成，请联系负责人。");
    if(config.mode==="managed"&&!config.authenticated)throw Error("请先填写助教访问码，验证服务使用权限。");
    if((settings.credentialMode||"test")!==(config.mode==="managed"?"managed":"test"))throw Error("本批次与当前服务模式不同，请备份后开启新批次。");
    validateStageProfiles(settings.stageProfiles);
    if(config.mode==="managed"&&!stageProfilesEqual(settings.stageProfiles,config.stageProfiles))throw Error("三阶段模型配置已变化，请备份后开启新批次，不会替换本批已保存的结果。");
    if(config.mode==="test"){
      const required=forGrading?["grade"]:["prepare"];
      for(const stage of required)if(!stageKeys[stage as keyof typeof stageKeys].trim())throw Error(`请填写第${stage==="prepare"?"一":stage==="grade"?"二":"三"}步的 ${getProvider(settings.stageProfiles[stage].provider).label} API key。`);
    }
    return config;
  }
  useEffect(() => { const prevent=(e:BeforeUnloadEvent)=>{if(running){e.preventDefault();e.returnValue="";}};window.addEventListener("beforeunload",prevent);return()=>window.removeEventListener("beforeunload",prevent); },[running]);
  useEffect(() => {
    const disconnected=()=>{setOffline(true);if(jobRef.current&&!jobRef.current.demo)setNotice("网络已断开，停止发送新请求；已发出的请求等待返回并保存。结果未定的请求不会自动重发。");};
    const reconnected=()=>{setOffline(false);if(jobRef.current&&!jobRef.current.demo)setNotice("网络已恢复。核对未完成记录后点击继续批改；已保存结果会复用，结果未定的请求仍需单独确认。");};
    setOffline(!navigator.onLine);window.addEventListener("offline",disconnected);window.addEventListener("online",reconnected);
    return()=>{window.removeEventListener("offline",disconnected);window.removeEventListener("online",reconnected);};
  }, []);
  const selected = job?.tasks.find((t:AnyData)=>t.id===selectedId);
  const unadopted = unadoptedResult(selected);
  const selectedIdentity = job?.documents?.find((d:AnyData)=>d.id===identityId);
  useEffect(()=>{
    let cancelled=false;const urls:string[]=[];setCoverPreview(null);setOriginalURL("");setCoverError("");setCoverBusy(!!selectedIdentity?.cover?.file);
    async function bind(){
      if(selectedIdentity?.file){const u=URL.createObjectURL(selectedIdentity.file);urls.push(u);if(!cancelled)setOriginalURL(u);}
      if(selectedIdentity?.cover?.file){const blob=await materializeStudentPDFPage(selectedIdentity.cover);if(cancelled)return;setCoverPreview({id:selectedIdentity.id,file:blob});}
    }
    bind().catch(()=>{if(!cancelled)setCoverError("身份首页暂时无法打开，请重新选择原PDF文件夹。");}).finally(()=>{if(!cancelled)setCoverBusy(false);});
    return()=>{cancelled=true;urls.forEach(u=>URL.revokeObjectURL(u));};
  },[identityId,answerFiles,job?.id,selectedIdentity?.cover?.file]);
  useEffect(()=>{
    let cancelled=false;const urls:{id:string,file:Blob,url:string,name:string,mime:string}[]=[];setPageURLs([]);setPreviewError("");setPreviewBusy(!!selected?.pages.some((p:AnyData)=>p.file));
    async function bind(){
      if(!selected)return;
      for(const p of selected.pages.filter((p:AnyData)=>p.file)){
        const blob=p.sourcePage?await materializeStudentPDFPage(p):p.file;if(cancelled)return;
        urls.push({id:selected.id,file:blob,url:URL.createObjectURL(blob),name:p.sourcePage?`原PDF第${p.sourcePage}页`:p.page_id,mime:blob.type||(p.path?.endsWith(".pdf")?"application/pdf":"image/jpeg")});
      }
      if(!cancelled)setPageURLs(urls);
    }
    bind().catch(()=>{if(!cancelled)setPreviewError("本题原页暂时无法打开，请重新选择原PDF文件夹。");}).finally(()=>{if(!cancelled)setPreviewBusy(false);});
    return()=>{cancelled=true;urls.forEach(p=>URL.revokeObjectURL(p.url));};
  },[selectedId,answerFiles,job?.id]);

  async function withAction(label:string,fn:()=>Promise<void>,inModal=false){
    if(actionRef.current)return false;
    actionRef.current=true;setBusy(label);
    if(inModal){setModalFeedback(null);setModalBusy(true);}else setNotice("");
    try{await fn();return true;}
    catch(e:any){const text=e.message||"操作未完成，请检查材料后重试。";if(inModal)setModalFeedback({kind:"error",text});else setNotice(text);return false;}
    finally{
      actionRef.current=false;setBusy("");
      if(inModal){setModalBusy(false);requestAnimationFrame(()=>{
        const dialog=document.querySelector<HTMLElement>('[role="dialog"]');
        if(dialog&&!dialog.contains(document.activeElement))dialog.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
      });}
    }
  }
  const hasDocuments=Object.values(documents).every(Boolean);
  const selectIndividualPDFs=job?.inputMode==="student_pdf"&&job.documents?.length>0&&job.documents.every((d:AnyData)=>!d.path.includes("/"));
  function persistPrep(){localStorage.setItem(PREP_KEY,JSON.stringify(prepRef.current));}
  async function lockedJob(id:string, fn:()=>Promise<void>){
    if(!navigator.locks)throw Error("请使用新版 Chrome 或 Edge 浏览器，以安全保存和运行批次。");
    await navigator.locks.request(storageName("grading-job:")+id,{ifAvailable:true},async lock=>{if(!lock)throw Error("这个批次正在另一个页面运行，请先暂停。");await fn();});
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
    if(actionRef.current||running)return;
    if(!jobRef.current){setAnswerFiles(files);return;}
    if(!files.length)return;
    await withAction("正在关联原答卷",async()=>{
      await lockedJob(jobRef.current.id,async()=>{const latest=await rebindJob({...jobRef.current},files);await saveJob(latest);updateJob(latest);});
      setAnswerFiles(files);
      setNotice("已核对并关联原答卷，可以直接查看和改分，无需填写 API key。");
    });
  }
  async function prepareRules(){
    if(!navigator.onLine){setNotice("当前网络未连接，请联网后整理评分规则。");return;}

    if(!uploadConsent){setNotice(`请确认将教师材料发送给 ${prepareProvider.label} 进行处理。`);return;}
    await withAction("正在整理评分规则",async()=>{
      const currentService=await ensureService();
      if(!navigator.locks)throw Error("请使用新版 Chrome 或 Edge，以防重复提交。");
      await navigator.locks.request(storageName("grading-runner"),{ifAvailable:true},async lock=>{
      if(!lock)throw Error("另一个页面正在处理请求，请先暂停该页面。");
      const saved=JSON.parse(localStorage.getItem(PREP_KEY)||"[]");if(Array.isArray(saved))prepRef.current=saved;
      if(prepRef.current.some(a=>!stageProfilesEqual(a.stageProfiles,settings.stageProfiles)))throw Error("已有其他阶段配置的费用记录，请开启新批次后切换模型。");
      const {documents:docs,documentHashes,inputs}=await prepareTeachingMaterials(documents,prepareProfile.provider);
      const reusable=restorePreparationDraft(prepRef.current,{documentHashes,provider:prepareProfile.provider,stageProfile:prepareProfile});
      if(reusable){setPack(reusable.pack);setPrepareResult(reusable);setPackApproved(false);setNotice("这三份材料已有保存的规则草案，已直接恢复，本次没有再次调用API。请核对后确认。");return;}
      if(prepRef.current.some(a=>a.costCny===null)&&!window.confirm("此前有规则整理请求费用未定，再次提交可能重复计费。确认继续？"))return;
      const committed=prepRef.current.reduce((n,a)=>n+(a.costCny??a.reservedCny),0);
      if(committed+settings.requestReserveCny>settings.budgetCny)throw Error("预算不足以预留这次规则整理请求，请在更多设置核对预算。");
      const requestId=crypto.randomUUID();
      const attempt:any={id:requestId,kind:"prepare",provider:prepareProfile.provider,stageProfile:prepareProfile,stageProfiles:settings.stageProfiles,documentHashes,inputs,state:"in_flight",reservedCny:settings.requestReserveCny,costCny:null,sentAt:new Date().toISOString()};
      prepRef.current.push(attempt);persistPrep();
      let response:Response,result:any;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),240000);
      try{
        response=await deploymentFetch("/api/prepare",{method:"POST",credentials:"same-origin",credentialMode:settings.credentialMode||"test",headers:{"Content-Type":"application/json",...(currentService.mode==="test"?{"X-Api-Key":prepareApiKey.trim()}:{}),"X-Api-Provider":prepareProfile.provider},body:JSON.stringify({documents:docs,requestId,stageProfiles:settings.stageProfiles}),signal:controller.signal});
        result=await response.json();for(const key of Object.values(stageKeys)){if(key.trim())result=JSON.parse(JSON.stringify(result).split(key.trim()).join("[REDACTED]"));}
        if(!result||typeof result!=="object"||Array.isArray(result)||((result.provider!==prepareProfile.provider||response.ok&&!profilesEqual(result.stageProfile,prepareProfile))&&!(!response.ok&&typeof result.error==="string"&&result.notSent===true&&result.uncertain===false&&result.estimatedCny===0)))throw Error("接口返回格式或服务商异常");
      }catch{
        attempt.state="uncertain";attempt.uncertain=true;attempt.error="规则整理请求中断，费用未定。";persistPrep();throw Error("规则整理请求中断，可能已计费；再次提交前请核查。原预留已保留。");
      }finally{clearTimeout(timer);}
      attempt.response=result;attempt.usage=result.usage;attempt.requestId=result.requestId;attempt.finishedAt=new Date().toISOString();
      attempt.costCny=typeof result.estimatedCny==="number"&&Number.isFinite(result.estimatedCny)&&result.estimatedCny>=0?result.estimatedCny:(!response.ok&&result.uncertain===false?0:null);
      attempt.state=response.ok?"done":result.uncertain?"uncertain":"error";persistPrep();
      if(!response.ok)throw Error(result.error||"规则识别没有完成。该请求可能已计费，请查看提示。");
      const checked=restorePreparationDraft(prepRef.current,{provider:prepareProfile.provider,stageProfile:prepareProfile});
      if(!checked){attempt.state="error";persistPrep();throw Error("规则结果未通过检查，本次费用记录已保留，请核对后再试。");}
      setPack(checked.pack);setPrepareResult(checked);setPackApproved(false);
      setNotice(!checked.ready?"评分规则已整理，仍有待核对问题。请在下方逐项处理并保存核对记录，再确认规则。":"评分规则已整理。普通说明不阻止确认；请核对题号、满分和评分点后继续。");
      });
    });
  }
  async function savePreparationReview(data:AnyData){
    if(jobRef.current)throw Error("批次已建立，规则不能再修改。请先备份并开启新批次。");
    if(actionRef.current||running)throw Error("请等待当前操作完成。");
    if(!navigator.locks)throw Error("请使用新版 Chrome 或 Edge 浏览器保存核对记录。");
    actionRef.current=true;setBusy("正在保存规则核对");
    try{
      await navigator.locks.request(storageName("grading-runner"),{ifAvailable:true},async lock=>{
        if(!lock)throw Error("另一个页面正在处理此批次，请先暂停该页面。");
        const saved=JSON.parse(localStorage.getItem(PREP_KEY)||"[]");
        if(JSON.stringify(saved)!==JSON.stringify(prepRef.current))throw Error("规则记录已在另一个页面更新。请刷新后重新核对，避免覆盖已有修改。");
        const next=reviewPreparationDraft(saved,data);
        const checked=restorePreparationDraft(next);
        if(!checked?.ready)throw Error("核对记录不完整，请逐项处理后再保存。");
        // Persist before changing the visible draft; a storage failure must not enable approval.
        localStorage.setItem(PREP_KEY,JSON.stringify(next));prepRef.current=next;
        setPack(checked.pack);setPrepareResult(checked);setPackApproved(false);setPreparationDirty(false);
        setNotice("核对记录已保存，未调用 API。请再核对下方规则并勾选确认；原始返回和费用记录已保留。");
      });
    }finally{actionRef.current=false;setBusy("");}
  }
  async function acceptPack(){
    if(preparationDirty)throw Error("规则修改尚未保存，请先保存核对记录或取消修改。");
    if(!pack || !packApproved)throw Error("请先核对整理后的评分规则。");
    if(!jobRef.current&&prepareResult){
      const saved=JSON.parse(localStorage.getItem(PREP_KEY)||"[]");
      const current=restorePreparationDraft(saved);
      if(!current?.ready||JSON.stringify(saved)!==JSON.stringify(prepRef.current)||JSON.stringify(current.pack)!==JSON.stringify(pack))throw Error("规则仍有未处理问题或记录已改变，请重新核对后确认。");
    }
    const approved={...pack,approved_by:pack.approved_by || prepareResult?.review?.reviewer || "上传者已确认评分规则"};validatePack(approved);
    return approved;
  }
  async function start(){
    if(running||busy||actionRef.current||!restored)return;
    if(job?.demo){actionRef.current=true;setRunning(true);stopRef.current=false;try{const result=await (runJob as any)(jobRef.current,{apiKey:"",onChange:updateJob,onProgress:setRunProgress,shouldStop:()=>stopRef.current});setNotice(result.reason||(result.paused?"已暂停，返回的结果已保存。":"演示完成，初评、模型复核与分歧均已保存。"));}catch(e:any){setNotice(e.message);}finally{actionRef.current=false;setRunning(false);setRunProgress(null);}return;}
    if(jobRef.current&&jobRef.current.settings.answerTransport!==ANSWER_TRANSPORT_VERSION){setNotice("此批次使用升级前的作答发送方式，已停止新请求。仍可查看、导出和人工确认；请先备份，再建立启用图片隔离的新批次。");return;}
    if(!navigator.onLine){setNotice("网络尚未恢复，已保存的进度可以查看；联网后再继续。");return;}

    if(!uploadConsent){setNotice("请勾选材料发送确认：首页用于姓名、学号识别，作答页按题单独发送。");return;}
    await withAction("正在检查本地答卷",async()=>{
      await ensureService(true);
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
      setRunning(true);setRunProgress(null);stopRef.current=false;
      try{const result=await (runJob as any)(next,{stageKeys:Object.fromEntries(Object.entries(stageKeys).map(([stage,key])=>[stage,key.trim()])),onChange:updateJob,onProgress:setRunProgress,shouldStop:()=>stopRef.current});setNotice(result.reason||(result.paused?"已暂停，返回的结果已保存。":result.requests===0?"本次没有发送新请求。已有结果直接复用；调用失败或费用未定的项目需查看原因、人工复核或单独确认重试。":"本轮处理完成，已保存结果。未完成项目可在下方查看原因。"));}
      finally{setRunning(false);setRunProgress(null);}
    });
  }
  async function loadDemo(){
    if(job&&!window.confirm("当前进度会被新的演示替代。需要保留时请先下载进度备份。继续吗？"))return;
    await withAction("准备演示",async()=>{const next=await studentPDFDemoJob({stageProfiles:DEFAULT_STAGE_PROFILES});await saveJob(next);updateJob(next);setSettings({...defaultSettings,...next.settings});setPrepareResult(null);setPreparationDirty(false);setPack(next.pack);setPackApproved(true);setApiKey("");setPrepareApiKey("");setReviewApiKey("");setSearch("");setSelectedId("");setNotice("这是每人一份PDF的合成演示，不连接 API。点击“开始演示”查看逐题初评、独立复核及建议分；包含一题分差不超过 2 分的合成示例。");});
  }
  async function reset(){if(!window.confirm("开启新批次会替换本浏览器的当前进度。请先下载进度备份。继续吗？"))return;await clearLastJob();prepRef.current=[];localStorage.removeItem(PREP_KEY);jobRef.current=null;setJob(null);setSelectedId("");setIdentityId("");setPack(null);setPrepareResult(null);setPreparationDirty(false);setPackApproved(false);setAnswerFiles([]);setApiKey("");setPrepareApiKey("");setReviewApiKey("");setSettings({...settingsWithStages(defaultSettings,runtimeConfig?.mode==="managed"&&runtimeConfig.stageProfiles?runtimeConfig.stageProfiles:DEFAULT_STAGE_PROFILES),credentialMode:runtimeConfig?.mode==="managed"?"managed":"test"});setNotice("已开启新批次。上次已下载的备份仍可重新导入。");}
  function backup(){if(job)download("阅卷进度_"+job.id.slice(0,8)+".json",JSON.stringify(snapshotJob(job),null,2));}
  async function loadPack(file:File){await withAction("读取统一规则",async()=>{if(job)throw Error("请先下载当前进度并开启新批次，再更换规则。");const raw=JSON.parse(await file.text());validatePack(raw);if(raw.demo)throw Error("合成规则不能用于真实答卷，请使用真实统一规则。");setPack(raw);setPrepareResult(null);setPreparationDirty(false);setPackApproved(true);setNotice("已导入统一规则，不需要再次上传试题、答案和细则。");});}
  async function restore(file:File){await withAction("恢复进度",async()=>{if(job&&!window.confirm("用备份替换当前进度？请先下载当前进度以免丢失。"))return;const recovered=await restoreSessionBackup(await file.text(),{hydrate:hydrateDemo,clearCredentials:()=>{setPrepareApiKey("");setApiKey("");setReviewApiKey("");}});const restored=recovered.job;updateJob(restored);setPrepareResult(null);setPreparationDirty(false);setPack(restored.pack);setPackApproved(true);setSettings({...defaultSettings,...restored.settings});setAnswerFiles([]);setSelectedId("");setNotice(IS_GITHUB_PAGES&&!restored.demo&&restored.settings.credentialMode==="managed"?MANAGED_BACKUP_NOTICE:recovered.usedLocal?"本机已有该批次的进度，已恢复本机记录；没有用上传备份覆盖，以免重复提交。页面密钥已清空，继续批改前请重新填写。":restored.demo?"演示备份及原图已恢复，可直接查看或改分。":IS_GITHUB_PAGES?"备份已恢复，三步骤的页面密钥已清空。重新选择原答卷文件夹即可查看和改分；继续批改前请重新填写各步骤的个人密钥。":"备份已恢复，三步骤的页面密钥已清空。重新选择原答卷文件夹即可查看和改分；继续批改前请验证服务权限或重新填写各步骤密钥。");});}
  function closeReview(){
    if(modalBusy)return;
    if((reviewDirty||identityDirty)&&!window.confirm("有尚未保存的修改，关闭后将丢弃这些修改。继续关闭吗？"))return;
    setSelectedId("");setIdentityId("");setModalFeedback(null);setReviewDirty(false);setIdentityDirty(false);
  }
  function chooseTask(t:AnyData,discardCheck=true){
    if(discardCheck&&reviewDirty&&!window.confirm("有尚未保存的改分，切换题目将丢弃这些修改。继续吗？"))return;
    t=jobRef.current?.tasks.find((candidate:AnyData)=>candidate.id===t.id)||t;
    setIdentityId("");setSelectedId(t.id);setModalFeedback(null);setReviewErrors({});setReviewDirty(false);setIdentityDirty(false);setTouchedScores({});
    const current=taskAdvice(jobRef.current,t);
    setScores(Object.fromEntries(t.question.criteria.map((c:AnyData)=>[c.criterion_id,hideAI&&!t.review?"":current.scores?.[c.criterion_id]?.toString()??""])));
    setReason("");setRetryConsent(false);
  }
  function changeHideAI(hidden:boolean){
    setHideAI(hidden);
    // Only clear untouched AI prefill; preserve saved human decisions and edited drafts.
    if(hidden&&!selected?.review){setScores(previous=>Object.fromEntries(selected.question.criteria.map((c:AnyData)=>[c.criterion_id,touchedScores[c.criterion_id]?previous[c.criterion_id]:""])));setReviewErrors({});}
  }
  async function saveReview(nextTask?:AnyData){
    if(actionRef.current)return;
    const errors:Record<string,string>={};
    if(!reviewer.trim())errors.reviewer="请填写复核人。";
    for(const c of selected?.question.criteria||[])if(!scores[c.criterion_id])errors[c.criterion_id]="请选择本评分点的分数。";
    setReviewErrors(errors);
    if(Object.keys(errors).length){
      setModalFeedback({kind:"error",text:"改分尚未保存，请补全标出的必填项。"});
      requestAnimationFrame(()=>{if(errors.reviewer)reviewerRef.current?.focus();else scoreRefs.current[Object.keys(errors)[0]]?.focus();});
      return;
    }
    const saved=await withAction("保存改分",async()=>{
    if(!selected)throw Error("请先选择题目。");
    if(!reviewer.trim())throw Error("请填写复核人。");
    const values=Object.fromEntries(Object.entries(scores).map(([k,v])=>{if(v==="")throw Error("请为所有评分点选择分数。");return [k,Number(v)];}));
    await lockedJob(jobRef.current.id,async()=>{
      const latest=await loadJob(jobRef.current.id)||jobRef.current;
      keepBoundPages(latest,jobRef.current);
      const target=latest.tasks.find((t:AnyData)=>t.id===selected.id);
      reviewTask(target,values,reviewer.trim(),reason.trim());await saveJob(latest);updateJob(latest);
    });setReviewDirty(false);setModalFeedback({kind:"success",text:"本题改分已保存，导出将采用新分数。"});
    },true);
    if(saved&&nextTask){chooseTask(nextTask,false);setModalFeedback({kind:"success",text:"上一题改分已保存，已进入下一题。"});}
  }
  async function retrySelected(){await withAction("重新排队",async()=>{
    assertDeploymentCanRun(jobRef.current);
    if(!selected)return;
    await lockedJob(jobRef.current.id,async()=>{const latest=keepBoundPages(await loadJob(jobRef.current.id)||jobRef.current,jobRef.current);const target=latest.tasks.find((t:AnyData)=>t.id===selected.id);requeueTask(target,retryConsent);await saveJob(latest);updateJob(latest);});
    setModalFeedback({kind:"success",text:"本题已重新排队。关闭窗口后点击继续批改即可重试。"});
  },true);}

  async function checkPDFs(){await withAction("正在检查PDF页数",async()=>{
    if(jobRef.current)throw Error("当前已有批次，请先备份后开启新批次。");
    const approved=await acceptPack();if(!answerFiles.length)throw Error("请先选择答题卡PDF文件夹。");
    const next=await createStudentPDFJob(approved,answerFiles,settings,roster.split(/\r?\n/).map(s=>s.trim()).filter(Boolean));
    attachPreparation(next,prepRef.current);await saveJob(next);updateJob(next);setPack(approved);
    setNotice("PDF已在本机检查，尚未调用API。可查看下方收件清单；服务就绪并开始后识别姓名学号及批改。");
  });}
  function chooseIdentity(d:AnyData){setSelectedId("");setIdentityId(d.id);setModalFeedback(null);setIdentityError("");setIdentityDirty(false);setReviewDirty(false);setIdentityStudentId(d.studentId||d.filenameStudentId||d.identityResult?.student_id||"");setIdentityName(d.identityReview ? d.identityReview.name ?? "" : d.name||d.identityResult?.name||"");setIdentityRetryConsent(false);}
  async function saveIdentity(){
    if(!identityStudentId.trim()){setIdentityError("请核对首页后填写学号。");setModalFeedback({kind:"error",text:"姓名学号尚未保存，请补全学号。"});identityInputRef.current?.focus();return;}
    setIdentityError("");
    await withAction("保存姓名学号",async()=>{
    if(!selectedIdentity)return;
    await lockedJob(jobRef.current.id,async()=>{const latest=keepBoundPages(await loadJob(jobRef.current.id)||jobRef.current,jobRef.current);resolveStudentIdentity(latest,identityId,{studentId:identityStudentId.trim(),name:identityName.trim()});await saveJob(latest);updateJob(latest);});
    setIdentityDirty(false);setModalFeedback({kind:"success",text:"姓名学号已保存，并已重新检查重复或名单冲突。后续导出采用当前信息。"});
  },true);}
  async function retryIdentity(){await withAction("重新排队识别",async()=>{
    assertDeploymentCanRun(jobRef.current);
    if(!selectedIdentity)return;
    await lockedJob(jobRef.current.id,async()=>{const latest=keepBoundPages(await loadJob(jobRef.current.id)||jobRef.current,jobRef.current);retryStudentIdentity(latest,identityId,identityRetryConsent);await saveJob(latest);updateJob(latest);});
    setModalFeedback({kind:"success",text:"首页识别已重新排队。关闭窗口后点击继续批改即可重试。"});
  },true);}

  const disabled=!!busy||running||!restored;
  const tasks:AnyData[]=job?.tasks||[];
  const summaries=tasks.map(t=>({...t,advice:taskAdvice(job,t),display:studentDisplay(job,t)}));
  const filtered=filterResults(summaries,{query:search,filter:resultFilter});
  const filteredDocuments=filterDocuments(job?.documents||[],summaries,{query:search,filter:resultFilter});
  const resultCounts=countResultFilters(summaries,{query:search});
  const documentCounts=countDocumentFilters(job?.documents||[],summaries,{query:search});
  const resultPagination=paginate(filtered,resultPage);
  const documentPagination=paginate(filteredDocuments,documentPage);
  const selectedPosition=filtered.findIndex((t:AnyData)=>t.id===selectedId);
  const previousTask=selectedPosition>0?filtered[selectedPosition-1]:null;
  const nextTask=selectedPosition>=0?filtered[selectedPosition+1]:filtered[0];
  useEffect(()=>{setResultPage(1);setDocumentPage(1);},[search,resultFilter,job?.id]);
  const completed=summaries.filter(t=>t.advice.total!==null).length;
  const pagesManagedBackup=IS_GITHUB_PAGES&&!!job&&!job.demo&&job.settings.credentialMode==="managed";
  const modelReviewsFinished=tasks.filter(t=>t.modelReviewState==="done").length;
  const modelReviewEnabled=!!job?.settings.reviewProfile;
  const activeRequests=tasks.filter(t=>t.state==="running"||t.modelReviewState==="running").length+(job?.documents||[]).filter((d:AnyData)=>d.identityState==="running").length;
  const identitiesFinished=(job?.documents||[]).filter((d:AnyData)=>d.identityResult||d.identityReview).length;
  const phaseText=runProgress?.phase==='reading'?(runProgress.kind==='identity'?"正在读取身份首页并准备图片":"正在读取 "+runProgress.questionId+" 作答并准备图片"):runProgress?.kind==='identity'?"正在等待首页识别结果":runProgress?.kind==='review'?"正在等待模型复核结果":"正在等待初评结果";
  const reviewCount=tasks.filter(t=>t.review).length;
  const studentIds=Array.from(new Set(filtered.map((t:AnyData)=>t.studentId)));
  const oneStudent=studentIds.length===1?studentIds[0]:null;
  const oneStudentLabel=oneStudent?(filtered[0]?.display.studentId||filtered[0]?.display.document?.path||oneStudent):null;
  const studentTasks=oneStudent?summaries.filter(t=>t.studentId===oneStudent):[];
  const studentTotal=studentTasks.length&&studentTasks.every(t=>t.advice.total!==null)?Math.round(studentTasks.reduce((s,t)=>s+t.advice.total,0)*10000)/10000:null;

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href={publicPath("/")}><span className="brand-icon"><BookOpen size={22}/></span><span>阅卷助手 · 国内版<small>三阶段独立配置 · 原卷复核 · 本机进度</small></span></a><div className="header-actions"><span className="tag"><ShieldCheck size={14}/>{IS_GITHUB_PAGES?"个人密钥模式 · 浏览器直连":runtimeConfig?.mode==="managed"?"统一服务 · 本机进度":"测试模式 · 本机进度"}</span><button className="text-button" onClick={loadDemo} disabled={disabled}>先体验演示 <ArrowRight size={15}/></button></div></header>
    <main>
      <section className="intro"><div><span className="eyebrow">给助教的一张工作台</span><h1>把材料放进来，<br className="mobile-break"/>让批改简单一点。</h1><p>上传统一材料，选择答卷文件夹，等待建议成绩。每题独立复核，分差不超过 2 分时合成建议，超过 2 分交人工确认。</p></div><div className="intro-note"><span>01 准备材料</span><ArrowRight size={16}/><span>02 初评与复核</span><ArrowRight size={16}/><span>03 导出成绩</span></div></section>
      {offline&&<div className="message" role="status"><AlertCircle size={18}/><span>当前离线 · 可查看已保存进度，联网后手动继续。</span></div>}
      {notice&&<div className="message" role="status"><AlertCircle size={18}/><span>{notice}</span><button aria-label="关闭提示" onClick={()=>setNotice("")}><X size={16}/></button></div>}
      {job?.demo&&<div className="demo-banner">当前为合成演示 · 不调用 API · 演示分数不代表真实评分效果 <button onClick={reset} disabled={disabled}>切换到真实批次</button></div>}
      <section className="workspace-card">
        <div className="section-title"><div><h2>准备本次批改</h2><p>只需这些材料。技术设置已经收好。</p></div><div className="quiet-links"><label className="file-link">导入统一规则<input type="file" accept=".json" disabled={disabled||!!job} onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value="";if(file)void loadPack(file);}}/></label><label className="file-link">恢复进度<input type="file" accept=".json" disabled={disabled} onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value="";if(file)void restore(file);}}/></label>{(job||prepRef.current.length>0)&&<button className="text-button" onClick={reset} disabled={disabled}>新批次</button>}</div></div>
        {packApproved&&pack&&!job?.demo?<div className="pack-ready"><Check size={18}/><span>已采用统一规则：{pack.title} · {pack.questions.length} 题 · {pack.questions.reduce((a:number,q:AnyData)=>a+q.max_score,0)} 分</span>{!job&&<button className="text-button" disabled={disabled} onClick={()=>{setPack(null);setPackApproved(false);setPrepareResult(null);setPreparationDirty(false);}}>重新选择材料</button>}</div>:<div className="document-grid">{["paper","solution","rubric"].map((role,index)=><TeachingMaterialUpload key={role} label={roleLabels[role]} number={index+1} file={documents[role]} accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp" formatHint="PDF / 图片 / 文本 · ≤3 MiB" disabled={disabled||!!job} onChange={file=>{setDocuments(previous=>({...previous,[role]:file}));setPack(null);setPackApproved(false);setPrepareResult(null);setPreparationDirty(false);}}/>)}</div>}
        <div className="input-grid"><div className="folder-section"><AnswerFileUpload files={answerFiles} individualPDFs={selectIndividualPDFs} disabled={disabled||!!job?.demo} removeAllowed={!job} onChange={chooseAnswerFolder}/><details className="folder-help"><summary>{selectIndividualPDFs?"怎样重新关联原卷？":"文件夹怎么放？"}<ChevronDown size={13}/></summary>{selectIndividualPDFs&&<p>这份进度按PDF文件名登记。请直接选择原来的PDF文件，文件名、内容和数量均须一致；无需选择整个文件夹。</p>}<p>每位同学一份扫描 PDF，命名为 <code>2026000001.pdf</code>。若有 m 道题，每份必须有 m＋1 页：第1页是姓名、学号等信息；第2页到第m＋1页依次对应第1题到第m题。无需手动拆分。</p><p>漏改文件名时尝试从首页补识别学号；身份冲突、重复学号和页数不符会单独提示。姓名读不清时留空，可手动更正。整份PDF最大64 MiB，拆出的每页最大3 MiB。完全漏收的学生需通过“更多设置”中的名单检查。</p></details>{packApproved&&answerFiles.length>0&&!job&&<button className="text-button" disabled={disabled} onClick={checkPDFs}>先检查PDF页数（不调用API）</button>}</div><ServiceAccess config={runtimeConfig} readOnly={pagesManagedBackup} error={configError} provider={provider} apiKey={apiKey} onKey={setApiKey} keyRef={keyRef} disabled={disabled} onAuthenticate={authenticate} onSignOut={signOut} onRetry={()=>{void withAction("正在连接服务",async()=>{await refreshService();});}}/></div>
        <StageConfiguration profiles={settings.stageProfiles} keys={stageKeys} managed={runtimeConfig?.mode==="managed"} readOnly={pagesManagedBackup} disabled={disabled} locked={!!job||prepRef.current.length>0} onKey={(stage,key)=>{if(stage==="prepare")setPrepareApiKey(key);else if(stage==="grade")setApiKey(key);else setReviewApiKey(key);}} onProfile={(stage,providerId,model)=>{const stages={...settings.stageProfiles,[stage]:getDefaultProfile(providerId,stage,model)};setSettings(settingsWithStages(settings,stages));if(settings.stageProfiles[stage].provider!==providerId||settings.stageProfiles[stage].model!==stages[stage].model){if(stage==="prepare")setPrepareApiKey("");else if(stage==="grade")setApiKey("");else setReviewApiKey("");}setNotice("已更新本步骤的模型；其他步骤保持各自配置。开始产生请求后，三阶段配置锁定。");}}/>
        {runtimeConfig?.mode==="test"&&!pagesManagedBackup&&!job?.demo&&!reviewApiKey.trim()&&<p className="rule-warning" role="status">可以先完成规则整理、姓名学号识别和初评；第三步密钥补齐后再继续独立复核。尚未复核的结果保持待确认。</p>}
        {pagesManagedBackup&&<p className="rule-warning" role="status">{MANAGED_BACKUP_NOTICE}</p>}
        <div className="review-configuration"><ShieldCheck size={19}/><div><strong>已启用独立模型复核</strong><p>{job?.demo?"合成初评 → 合成复核。演示包含一题小分差合成建议，不连接真实模型、不计费。":`初评：${settings.stageProfiles.grade.model} → 复核：${settings.stageProfiles.review.model}。复核只看原卷和评分规则，不接收初评分数；两份结果保留，每题分差不超过 2 分时取平均向上取整，超过 2 分再交人工。`}</p></div></div>
        <details className="advanced"><summary>更多设置与费用 <ChevronDown size={14}/></summary><div className="advanced-body"><p>默认同时处理4个请求，每次完成后保存并补上下一项。模型尚未经本课程验收，费用按各步骤的公开费率快照估算，以服务商账单为准。</p><div className="advanced-grid"><label>本批预算（元）<input type="number" min="5" max="5000" value={settings.budgetCny} disabled={!!job||disabled} onChange={e=>setSettings({...settings,budgetCny:Number(e.target.value)})}/></label><label>同时处理的请求数<select value={settings.concurrency} disabled={!!job||disabled} onChange={e=>setSettings({...settings,concurrency:Number(e.target.value)})}>{[1,2,4].map(n=><option key={n} value={n}>{n} 个</option>)}</select></label><label>单次费用预留（元）<input type="number" min="1" max="100" value={settings.requestReserveCny} disabled={!!job||disabled} onChange={e=>setSettings({...settings,requestReserveCny:Number(e.target.value)})}/></label></div><label className="roster-label">应收学号名单（选填，每行一个；可发现完全漏交的同学）<textarea rows={3} value={roster} disabled={!!job||disabled} onChange={e=>setRoster(e.target.value)} placeholder="2026001&#10;2026002"/></label><p>预算同时计入已用费用、在途请求和费用未定的预留。额度不足、限流或断网后停止补发，不自动重试可能已计费的调用。已产生请求后若需更换任一步骤，请先备份并开启新批次。</p><p>三家服务均使用国内官方接口。所有PDF在本机按页转为图片；教学PDF每份最多20页，三份材料转换后合计≤6 MiB。Word请先另存为PDF或UTF-8文本。页面关闭后密钥清空，进度保留在本浏览器。</p></div></details>
        {pack&&<div className="rule-preview"><div className="rule-heading"><h3>{pack.title || "评分规则预览"}</h3><span>{pack.questions.length} 题 · {pack.questions.reduce((s:number,q:AnyData)=>s+q.max_score,0)} 分</span></div>{prepareResult?.warnings?.length>0&&<div className="rule-warning"><strong>{prepareResult.ready?"已记录处理依据的提示":"待核对问题"}</strong>{prepareResult.warnings.map((w:string,i:number)=><p key={i}>{w}</p>)}<p>{prepareResult.ready?"原始提示已保留，可展开核对记录查看处理依据。":"请展开“核对并修正规则”，逐项记录教师规定或核对依据。尚未解决的缺漏、冲突不能直接确认。"}</p></div>}
          {prepareResult&&!job&&<PreparationReview key={(prepRef.current.at(-1)?.id||"draft")+":"+(prepareResult.review?.reviewedAt||"original")} pack={pack} warnings={prepareResult.warnings||[]} notes={prepareResult.notes||[]} review={prepareResult.review} disabled={disabled} onSave={savePreparationReview} onEditingChange={dirty=>{setPreparationDirty(dirty);if(dirty)setPackApproved(false);}}/>}<div className="question-chips">{pack.questions.map((q:AnyData)=><details key={q.question_id}><summary>{q.question_id}<b>{q.max_score} 分</b><ChevronDown size={13}/></summary><div><p>{q.text}</p><p>参考答案：{q.solution}</p>{q.criteria.map((c:AnyData)=><p key={c.criterion_id}><strong>{c.criterion_id}：</strong>{c.description}<br/><small>允许分值：{c.allowed_scores.join(" / ")}</small></p>)}</div></details>)}</div><details className="review-rules"><summary>评分政策<ChevronDown size={14}/></summary><p>{pack.policies}</p></details>{!packApproved&&!job&&<label className="checkline"><input type="checkbox" checked={packApproved} disabled={disabled||preparationDirty||!!prepareResult&&!prepareResult.ready} onChange={e=>setPackApproved(e.target.checked)}/>我已核对题号、满分和评分点与教师要求一致。</label>}<button className="text-button" disabled={!packApproved||disabled||preparationDirty} onClick={async()=>{try{const p=await acceptPack();download("统一评分规则.json",JSON.stringify(p,null,2));}catch(e:any){setNotice(e.message);}}}><Download size={14}/>下载统一规则，供其他助教直接导入</button></div>}
        {!job?.demo&&<label className="checkline upload-consent"><input type="checkbox" checked={uploadConsent} onChange={e=>setUploadConsent(e.target.checked)} disabled={disabled}/>我确认将教师材料发送给 {prepareProvider.label} 整理规则，将身份首页与匿名作答分别发送给 {provider.label} 识别和初评，并将匿名作答发送给 {getProvider(settings.stageProfiles.review.provider).label} 独立复核，理解各步骤会产生 API 费用。</label>}
        <div className="start-row"><p><ShieldCheck size={16}/>{job?.demo?"演示不需要密钥，也不会联网批改":"PDF本地拆页转图，身份与评分分别发送"}</p>{running?<button className="button primary" onClick={()=>{stopRef.current=true;setNotice("已停止补发；等待所有在途请求完成并保存，请先保持页面打开。");}}><Pause size={17}/>暂停批改</button>:<button className="button primary" disabled={!!busy||!restored||pagesManagedBackup||preparationDirty||(!pack&&!hasDocuments)||!!pack&&!job&&!packApproved} onClick={pack?start:prepareRules}>{busy?<span className="spinner"/>:job?.demo?<Play size={17}/>:<ArrowRight size={17}/>} {busy||(!pack?"整理评分规则":job?.demo?"开始演示":job?"继续批改":"开始批改")}</button>}</div>
      </section>
      {job&&!job.demo&&job.settings.answerTransport!==ANSWER_TRANSPORT_VERSION&&<p className="rule-warning" role="status">此批次保留升级前的设置，仅可查看、导出和人工确认。请先备份，再建立新批次使用作答图片隔离；不会自动修改旧结果或继续旧请求。</p>}
      <section className="results-section" ref={resultsRef}><div className="section-title"><div><h2>建议成绩与模型复核</h2><p>按每道题比较：同分保留原分；分差 ≤ 2 取平均向上取整；分差 &gt; 2 交人工。</p></div>{job&&<div className="quiet-links"><button className="text-button" onClick={backup} disabled={disabled}><Download size={15}/>进度备份</button><button className="button secondary" onClick={()=>download("AI建议成绩.csv",exportCSV(job),"text/csv;charset=utf-8")}><Download size={16}/>导出建议成绩</button></div>}</div>{!job?<div className="empty-state"><span><FileText size={32} strokeWidth={1.2}/></span><h3>成绩会出现在这里</h3><p>准备好材料后开始批改，或先体验无需密钥的演示。</p></div>:<><div className={"stats-row"+(modelReviewEnabled?" with-model-review":"")}><div><span>本批任务</span><strong>{tasks.length}<small>题</small></strong></div><div><span>已生成建议</span><strong>{completed}<small>题</small></strong></div>{modelReviewEnabled&&<div><span>模型复核完成</span><strong>{modelReviewsFinished}<small>/ {tasks.length} 题</small></strong></div>}<div><span>人工确认</span><strong>{reviewCount}<small>题</small></strong></div><div><span>费用估算 + 未决预留</span><strong className="cost">{money((job.spentCny||0)+(job.heldCny||0))}<small>/ {money(job.settings.budgetCny)}</small></strong></div></div>{running&&<p className="run-status" role="status">{phaseText} · 首页识别 {identitiesFinished} / {job.documents?.length||0} 份 · 初评 {tasks.filter(t=>t.result).length} / {tasks.length} 题{modelReviewEnabled&&` · 模型复核 ${modelReviewsFinished} / ${tasks.length} 题`}</p>}<div className="progress"><i style={{width:`${tasks.length?100*completed/tasks.length:0}%`}}/></div><div className="result-toolbar"><div className="search-box"><Search size={18}/><input aria-label="按学号搜索" value={search} onChange={e=>setSearch(e.target.value)} placeholder="输入学号、姓名或文件名查找"/></div><span>{running?`同时处理 ${activeRequests} / ${job.settings.concurrency} 个请求 · 每次完成后保存`:oneStudent?`${oneStudentLabel} · 建议总分 ${studentTotal===null?"未完成":studentTotal}`:"进度保存在此浏览器，可随时下载备份"}</span></div>{hasUncertainCost(job.preparationAttempts)&&<p className="rule-warning" role="status">规则整理仍有费用未定请求，需核查后再继续。此费用不归属学生，不计入下方题目或答卷数量。</p>}<div className="result-filters" role="group" aria-label="按处理状态筛选">{RESULT_FILTERS.map((option:any)=><button key={option.id} type="button" className={resultFilter===option.id?"active":""} aria-pressed={resultFilter===option.id} onClick={()=>setResultFilter(option.id)}>{option.label}<span>{resultCounts[option.id]} 题{job.inputMode==="student_pdf"?` / ${documentCounts[option.id]} 份`:""}</span></button>)}</div><p className="filter-help">筛选同时作用于收件和题目列表；费用未定与已完成可能重叠。待处理项目不会自动重试。</p>{job.inputMode==="student_pdf"&&<details className="pdf-collection" open><summary>PDF收件与姓名识别 <span>{filteredDocuments.length} / {job.documents.length} 份</span></summary><p>首页单独识别姓名、学号；姓名读不清不猜填。身份冲突或页数异常的答卷会暂留未完成，其余可以继续。</p><div className="table-scroll"><table><thead><tr><th>原PDF文件</th><th>页数</th><th>学号</th><th>姓名</th><th>状态</th><th></th></tr></thead><tbody>{documentPagination.items.map((d:AnyData)=><tr key={d.id}><td className="pdf-filename">{d.path}</td><td>{d.pageCount??"—"} / {d.expectedPageCount||job.pack.questions.length+1}</td><td>{d.studentId||d.filenameStudentId||"待补学号"}</td><td>{d.name||"—"}<small className="name-source">{d.nameSource==="manual"?"人工更正":d.name?"手写识别":""}</small></td><td><span className={"state "+(d.mappingStatus==="ready"?"complete":"")}>{["error","uncertain"].includes(d.identityState)?"识别未完成":identityLabels[d.mappingStatus]||d.mappingStatus}</span>{d.inputError&&<small className="document-error">{d.inputError}</small>}{d.identityError&&<small className="document-error">{d.identityError}</small>}{!d.inputError&&d.identityWarnings?.length>0&&<small className="document-error">{d.identityWarnings.join("；")}</small>}</td><td><button className="text-button" disabled={disabled} onClick={()=>chooseIdentity(d)}>查看 / 更正</button></td></tr>)}</tbody></table></div>{!filteredDocuments.length&&<p className="table-note">没有符合当前搜索和状态的答卷。</p>}<Pagination label="答卷" data={documentPagination} onChange={setDocumentPage}/></details>}
        <div className="table-scroll"><table><thead><tr><th>学号</th><th>姓名</th><th>题号</th>{modelReviewEnabled&&<><th>初评分</th><th>复核分</th></>}<th>建议分</th><th>状态</th><th>分数来源</th><th></th></tr></thead><tbody>{resultPagination.items.map((t:AnyData)=><tr key={t.id}><td className="student-cell">{t.display.studentId||"待补学号"}</td><td>{t.display.name||"—"}</td><td>{t.questionId}</td>{modelReviewEnabled&&<><td>{computeReviewComparison(t).initialTotal??"—"}</td><td>{computeReviewComparison(t).reviewTotal??"—"}</td></>}<td className="score-cell">{t.advice.total===null?"—":t.advice.total}<small> / {t.question.max_score}</small></td><td><span className={"state "+(t.advice.total!==null?"complete":"")}>{t.display.document&&t.display.status!=="ready"?(identityLabels[t.display.status]||t.display.status):t.review?"已人工确认":getTaskFlags(t).instruction?"疑似干扰指令 · 待核查":t.modelReviewState&&t.result?modelReviewLabels[computeReviewComparison(t).status]:t.result?.status==="needs_review"?"评分有待定项":stateLabels[t.state]||t.state}</span>{!t.review&&t.modelReviewError&&<small className="document-error">{t.modelReviewError}</small>}{!t.review&&t.error&&<small className="document-error">{t.error}</small>}{getTaskFlags(t).uncertain&&<small className="document-error">费用未定，请核查请求记录</small>}</td><td>{t.advice.source==="human"?"人工改分":t.advice.source==="ai_adjusted"?"两次平均向上取整":t.advice.source==="ai_review"?"本题两次同分":t.advice.source==="ai"?"初评建议":computeReviewComparison(t).status==="disagreement"?"待人工确认":"待定"}</td><td><button className="text-button" onClick={()=>chooseTask(t)}>查看 / 改分 <ArrowRight size={14}/></button></td></tr>)}</tbody></table>{!filtered.length&&<p className="table-note">没有符合当前搜索和状态的题目。</p>}</div><Pagination label="题目" data={resultPagination} onChange={setResultPage}/><p className="results-note">每题初评一次，配置后使用另一模型复核一次。复核先独立评分，再逐题比较。两次同分直接采用；分差不超过 2 分取平均向上取整，且不超过本题满分；超过 2 分或有异常标记时交人工。两份原结果及人工确认分保留。缺页、读不清和调用失败不按零分处理，未完成题目使总分留空。自动结果是建议成绩，正式用途仍需教师确认。</p></>}</section>
      <footer><span>阅卷助手 · 国内版</span><p>{IS_GITHUB_PAGES?"个人密钥直连 · 页面关闭后不会继续后台批改":"无需安装 · 正式服务统一配置 · 页面关闭后不会继续后台批改"}</p><a href={provider.pricingUrl} target="_blank" rel="noreferrer">模型与费用说明 ↗</a></footer>
    </main>
    {selectedIdentity&&<ReviewDialog label="身份核对" eyebrow="姓名与学号" title={selectedIdentity.path} busy={modalBusy} onClose={closeReview}>
      <ModalMessage feedback={modalFeedback}/>
      <div className="review-columns">
        <div className="evidence-panel"><h3>原PDF身份首页</h3>
          {coverPreview?.id===identityId?<PDFPreview file={coverPreview.file} name="原PDF身份首页"/>:<p className="evidence-empty" role={coverError?"alert":"status"}>{coverError||(coverBusy?"正在本机准备身份首页…":"重新选择原答卷文件夹后可核对首页。")}</p>}
          {originalURL&&<a className="text-button" href={originalURL} target="_blank" rel="noreferrer">打开完整原始PDF（仅在本机查看）</a>}
          <p className="results-note">系统只提取学生姓名和学号，忽略授课教师、分数表及考试纪律。</p>
        </div>
        <div className="review-panel">
          {selectedIdentity.inputError&&<div className="rule-warning">{selectedIdentity.inputError}</div>}
          {selectedIdentity.identityError&&<div className="rule-warning">{selectedIdentity.identityError}</div>}
          <p>文件名学号：{selectedIdentity.filenameStudentId||"未按学号命名"}<br/>首页识别学号：{selectedIdentity.identityResult?.student_id||"未识别或读不清"}<br/>首页识别姓名：{selectedIdentity.identityResult?.name||"未识别或读不清"}</p>
          <label className="review-field">学号 <small>必填</small><input ref={identityInputRef} inputMode="numeric" value={identityStudentId} aria-invalid={!!identityError} aria-describedby={identityError?"identity-field-error":undefined} onChange={e=>{setIdentityStudentId(e.target.value);setIdentityDirty(true);setIdentityError("");setModalFeedback(null);}} disabled={disabled} placeholder="核对首页后填写，保留开头的0"/>{identityError&&<span id="identity-field-error" className="field-error">{identityError}</span>}</label>
          <label className="review-field">姓名 <small>读不清可留空</small><input value={identityName} onChange={e=>{setIdentityName(e.target.value);setIdentityDirty(true);setModalFeedback(null);}} disabled={disabled}/></label>
          <button className="button primary full" onClick={saveIdentity} disabled={disabled||!selectedIdentity.cover?.file}><Check size={16}/>{busy==="保存姓名学号"?"正在保存…":"保存姓名学号"}</button>
          <p className="results-note">无需填写理由；保存会记录这次人工更正。重复学号仍需处理，页数问题需修复原PDF后开启新批次。</p>
          {!pagesManagedBackup&&["error","uncertain"].includes(selectedIdentity.identityState)&&<details className="retry-panel"><summary>重新识别首页</summary><label className="checkline"><input type="checkbox" checked={identityRetryConsent} disabled={disabled} onChange={e=>setIdentityRetryConsent(e.target.checked)}/>已检查原因，理解重试可能再次计费。</label><button className="button secondary" disabled={disabled} onClick={retryIdentity}><RotateCcw size={14}/>重新排队识别</button></details>}
        </div>
      </div>
    </ReviewDialog>}
    {selected&&<ReviewDialog label="复核" eyebrow="原卷对照 · 人工确认" title={<>{studentDisplay(job,selected).studentId||"待补学号"} {studentDisplay(job,selected).name||""} <small>· {selected.questionId}</small></>} busy={modalBusy} onClose={closeReview}>
      <ModalMessage feedback={modalFeedback}/>
      <div className="review-navigation"><span>{selectedPosition>=0?`当前筛选第 ${selectedPosition+1} / ${filtered.length} 题`:"本题已不在当前筛选中"}{reviewDirty?" · 有未保存修改":""}</span><div><button className="text-button" disabled={disabled||!previousTask} onClick={()=>chooseTask(previousTask)}>上一题</button><button className="text-button" disabled={disabled||!nextTask} onClick={()=>chooseTask(nextTask)}>下一题 <ArrowRight size={14}/></button></div></div>
      <div className="review-columns">
        <div className="evidence-panel"><h3>{job?.inputMode==="student_pdf"?"本题对应的PDF页面":"原图与续页"}</h3>
          {pageURLs.some(p=>p.id===selectedId)?pageURLs.filter(p=>p.id===selectedId).map(p=><figure key={p.name}>{p.mime==="application/pdf"?<PDFPreview file={p.file} name={p.name}/>:<><a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.name+"原始答卷"}/></a><figcaption>{p.name} · 点击查看原件</figcaption></>}</figure>):<p className="evidence-empty" role={previewError?"alert":"status"}>{previewError||(previewBusy?"正在本机准备本题原卷…":"请关闭此窗口并重新选择原答卷文件夹，即可关联原卷和改分，无需 API key。已保存的评分记录仍在。")}</p>}
        </div>
        <div className="review-panel">
          <InstructionConcern task={selected} hideDetails={hideAI}/>
          <ModelReviewSummary task={selected} profile={job.settings.reviewProfile} hideScores={hideAI}/>
          <details className="review-rules"><summary>试题与评分要求<ChevronDown size={14}/></summary><p>{selected.question.text}</p><p>参考答案：{selected.question.solution}</p><p>{job.pack.policies}</p></details>
          {!selected.review&&selected.error&&<div className="rule-warning">{selected.error}</div>}
          {getTaskFlags({...selected,display:studentDisplay(job,selected),advice:taskAdvice(job,selected)}).uncertain&&<div className="rule-warning">本题或对应首页仍有费用未定请求。人工改分不会结清费用，也不会自动重试。</div>}
          <label className="checkline"><input type="checkbox" checked={hideAI} disabled={disabled} onChange={e=>changeHideAI(e.target.checked)}/>隐藏 AI 建议，独立查看</label>
          {hideAI&&<p className="results-note">未编辑的 AI 建议分不再预填；已保存的人工改分和本次手动选择会保留。</p>}
          {selected.question.criteria.map((c:AnyData)=><div className="review-criterion" key={c.criterion_id}>
            <div className="criterion-heading"><h4>{c.criterion_id} · {c.description}</h4><select ref={node=>{scoreRefs.current[c.criterion_id]=node;}} aria-label={c.criterion_id+"改判分数"} aria-invalid={!!reviewErrors[c.criterion_id]} aria-describedby={reviewErrors[c.criterion_id]?`score-error-${c.criterion_id}`:undefined} value={scores[c.criterion_id]??""} disabled={disabled} onChange={e=>{setScores({...scores,[c.criterion_id]:e.target.value});setTouchedScores(previous=>({...previous,[c.criterion_id]:true}));setReviewDirty(true);setReviewErrors(previous=>({...previous,[c.criterion_id]:""}));setModalFeedback(null);}}><option value="">选择分数</option>{c.allowed_scores.map((n:number)=><option key={n} value={n}>{n} 分</option>)}</select></div>
            {reviewErrors[c.criterion_id]&&<p id={`score-error-${c.criterion_id}`} className="field-error">{reviewErrors[c.criterion_id]}</p>}
            {!hideAI&&<div className="grading-reason">{(()=>{const r=selected.result?.criteria.find((r:AnyData)=>r.criterion_id===c.criterion_id);return <div><b>初评建议 · {r?(r.awarded===null?"待定":r.awarded+" 分"):"暂无结果"}</b><p>{r?.reason}</p>{!r&&unadopted&&(()=>{const raw=unadopted.criteria.find((v:AnyData)=>v?.criterion_id===c.criterion_id);return raw&&<div className="unadopted-result"><b>未采用的模型返回 · {typeof raw.awarded==="number"?raw.awarded+" 分":"待定"}</b><p>本点允许：{c.allowed_scores.join(" / ")} 分</p><p>{typeof raw.reason==="string"?raw.reason:""}</p></div>;})()}{r&&<small>证据：{r.evidence_refs.join("、")}</small>}</div>;})()}<ModelReviewCriterion task={selected} criterionId={c.criterion_id}/></div>}
          </div>)}
          <label className="review-field">复核人 <small>必填</small><input ref={reviewerRef} value={reviewer} disabled={disabled} aria-invalid={!!reviewErrors.reviewer} aria-describedby={reviewErrors.reviewer?"reviewer-field-error":undefined} onChange={e=>{setReviewer(e.target.value);setReviewDirty(true);setReviewErrors(previous=>({...previous,reviewer:""}));setModalFeedback(null);}} placeholder="填写姓名"/>{reviewErrors.reviewer&&<span id="reviewer-field-error" className="field-error">{reviewErrors.reviewer}</span>}</label>
          <label className="review-field">审阅依据 / 改判理由 <small>选填</small><textarea rows={2} value={reason} disabled={disabled} onChange={e=>{setReason(e.target.value);setReviewDirty(true);setModalFeedback(null);}} placeholder="可以留空，直接保存改分"/></label>
          <div className="review-save-actions"><button className="button primary" disabled={disabled||!selected.inputComplete||(job?.inputMode==="student_pdf"&&studentDisplay(job,selected).status!=="ready")} onClick={()=>saveReview()}><Check size={16}/>{busy==="保存改分"?"正在保存…":"保存本题改分"}</button>{nextTask&&<button className="button secondary" disabled={disabled||!selected.inputComplete||(job?.inputMode==="student_pdf"&&studentDisplay(job,selected).status!=="ready")} onClick={()=>saveReview(nextTask)}>保存并下一题 <ArrowRight size={14}/></button>}</div>
          {selected.review&&<p className="saved-review">最近改分：{selected.review.reviewer} · {new Date(selected.review.at).toLocaleString()} {selected.review.reason||"（未填写理由）"}</p>}
          {!pagesManagedBackup&&["error","uncertain"].includes(selected.state)&&<details className="retry-panel"><summary>这道题需要重试？</summary><label className="checkline"><input type="checkbox" checked={retryConsent} disabled={disabled} onChange={e=>setRetryConsent(e.target.checked)}/>已检查原因，理解重试可能再次计费。</label><button className="button secondary" disabled={disabled} onClick={retrySelected}><RotateCcw size={14}/>重新排队</button></details>}
        </div>
      </div>
    </ReviewDialog>}
  </div>;
}
