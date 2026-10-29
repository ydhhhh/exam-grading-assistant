/** Browser-owned task ledger. No API key is ever part of a job or its backup. */
import {VERSION,MODEL,RESOURCE_LIMITS,validatePack,validateResult,validateScores,advice,sumScores} from './validation.mjs';
import {validateIdentityResult} from './identity-validation.mjs';

export const DEFAULT_SETTINGS=Object.freeze({budgetCny:100,concurrency:4,requestReserveCny:5,reasoning:'medium',outputTokens:8000});
const MAX_PAGE=RESOURCE_LIMITS.fileBytes, MAX_TASK=RESOURCE_LIMITS.filesBytes;
const SHA=/^[a-f0-9]{64}$/;
const STATES=new Set(['ready','input_missing','running','done','error','uncertain']);
const fail=message=>{throw new Error(message);};
const finite=(n,name)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0)fail(`${name}不是有效的非负数。`);return n;};
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const uuid=()=>globalThis.crypto.randomUUID();
const money=n=>Math.round(n*1e8)/1e8;
const mimeFor=name=>({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',txt:'text/plain',md:'text/markdown'})[String(name).split('.').pop().toLowerCase()];

export function canonical(value){
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'){if(!Number.isFinite(value))fail('数据包含非有限数。');return JSON.stringify(value);}
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)!==Date.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  fail('不能对未定义或非JSON数据建立校验记录。');
}
const hashBytes=async bytes=>[...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
export const hashJSON=async value=>hashBytes(new TextEncoder().encode(canonical(value)));

function normalizedPath(file){
  const path=String(file.webkitRelativePath||file.name||'').replaceAll('\\','/');
  if(!path||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..')||/[\u0000-\u001f]/.test(path))fail('文件路径无效。');
  return path;
}
function ignored(path){return path.split('/').some(p=>p.startsWith('.')||p==='__MACOSX');}
function checkSignature(bytes,mime){
  const b=new Uint8Array(bytes),s=new TextDecoder('latin1').decode(b.slice(0,12));
  if(mime==='image/png'&&!(b[0]===137&&s.slice(1,4)==='PNG'))fail('PNG文件内容不正确。');
  if(mime==='image/jpeg'&&!(b[0]===255&&b[1]===216&&b[2]===255))fail('JPEG文件内容不正确。');
  if(mime==='image/webp'&&!(s.slice(0,4)==='RIFF'&&s.slice(8,12)==='WEBP'))fail('WebP文件内容不正确。');
  if(mime==='application/pdf'&&s.slice(0,5)!=='%PDF-')fail('PDF文件内容不正确。');
  if(mime?.includes('wordprocessingml')&&!(b[0]===80&&b[1]===75))fail('DOCX文件内容不正确。');
}
function toBase64(bytes){
  const array=new Uint8Array(bytes);let s='';
  for(let i=0;i<array.length;i+=0x8000)s+=String.fromCharCode(...array.subarray(i,i+0x8000));
  return globalThis.btoa(s);
}
export async function readUpload(file,name){
  if(!file||typeof file.arrayBuffer!=='function'||!Number.isFinite(file.size)||file.size<=0||file.size>MAX_PAGE)fail('文件为空或超过3 MiB。');
  const mime=mimeFor(file.name)||file.type;if(!mime)fail('文件格式不支持。');
  const bytes=await file.arrayBuffer();if(bytes.byteLength!==file.size)fail('读取文件长度发生变化。');
  checkSignature(bytes,mime);
  return {name:name||file.name,mime,data:toBase64(bytes),sha256:await hashBytes(bytes)};
}

function parseAnswer(path,qids){
  const parts=path.split('/');
  if(parts.length===3&&identifier(parts[0])&&qids.has(parts[1]))return {studentId:parts[0],questionId:parts[1],order:parts[2].replace(/\.[^.]+$/,'')};
  if(parts.length===1){
    // Match against known question IDs, so student IDs may themselves contain underscores.
    const stem=parts[0].replace(/\.[^.]+$/,'');const matches=[];
    for(const qid of qids){
      const marker='_'+qid;const position=stem.lastIndexOf(marker);
      if(position<1)continue;
      const studentId=stem.slice(0,position),tail=stem.slice(position+marker.length);
      if(identifier(studentId)&&(tail===''||/^_[A-Za-z0-9-]+$/.test(tail)))matches.push({studentId,questionId:qid,order:tail.slice(1)||'01'});
    }
    if(matches.length===1)return matches[0];
  }
  return null;
}
function locateAnswer(path,qids){
  const direct=parseAnswer(path,qids);if(direct)return direct;
  const parts=path.split('/');if(parts.length>1)return parseAnswer(parts.slice(1).join('/'),qids);
  return null;
}

export async function indexAnswers(files,pack,optionalRoster=[]){
  validatePack(pack);if(!Array.isArray(optionalRoster))fail('名单应为编号列表。');
  const roster=optionalRoster.map(s=>String(s).trim());
  if(roster.some(s=>!identifier(s))||new Set(roster).size!==roster.length)fail('名单存在无效或重复的学号。');
  const qids=new Set(pack.questions.map(q=>q.question_id)),students=new Set(roster),groups=new Map(),seen=new Set(),warnings=[];
  const list=Array.from(files||[]);if(list.length>20000)fail('一次选择最多20000个文件。');
  for(const file of list){
    const path=normalizedPath(file);if(ignored(path))continue;
    if(seen.has(path))fail('重复文件路径：'+path);seen.add(path);
    const mime=mimeFor(path);if(!['image/png','image/jpeg','image/webp','application/pdf'].includes(mime))fail('答卷包含不支持的文件：'+path+'。请用分页图片或明确题号的PDF。');
    const mapping=locateAnswer(path,qids);if(!mapping)fail('无法确定学号和题号：'+path+'。请使用 学号/Q1/01.jpg 或 学号_Q1_01.jpg。');
    if(roster.length&&!students.has(mapping.studentId))fail('答卷中存在名单外学生：'+mapping.studentId);
    students.add(mapping.studentId);
    if(!file.size||file.size>MAX_PAGE)fail('每个作答文件须大于0且不超过3 MiB：'+path);
    const bytes=await file.arrayBuffer();checkSignature(bytes,mime);const sha256=await hashBytes(bytes);
    const id=mapping.studentId+'::'+mapping.questionId;
    if(!groups.has(id))groups.set(id,[]);
    const pages=groups.get(id);
    if(pages.some(p=>p.order===mapping.order))fail('同一学生同一题的页面顺序重复：'+path);
    if(pages.some(p=>p.sha256===sha256))fail('同一题存在字节完全相同的重复页：'+path);
    pages.push({file,path,sha256,mime,size:file.size,order:mapping.order});
  }
  if(!students.size)fail('没有可处理的学生答卷。');
  const tasks=[];
  for(const studentId of [...students].sort())for(const question of pack.questions){
    const key=studentId+'::'+question.question_id;
    const pages=(groups.get(key)||[]).sort((a,b)=>a.order.localeCompare(b.order,'en',{numeric:true}));
    if(pages.length>30||pages.reduce((n,p)=>n+p.size,0)>MAX_TASK)fail('同一道题最多30个文件、合计6 MiB：'+key);
    tasks.push({id:key,studentId,questionId:question.question_id,question,pages:pages.map((p,i)=>({page_id:'P'+(i+1),file:p.file,path:p.path,sha256:p.sha256,mime:p.mime,size:p.size})),inputComplete:!!pages.length,state:pages.length?'ready':'input_missing',result:null,review:null,reviewHistory:[],attempts:[],error:pages.length?'':'缺少该题作答，分数留空。'});
  }
  if(!roster.length)warnings.push('未提供全班名单，能发现已收学生的缺题，但无法发现整份未收的学生。');
  warnings.push('页数来自所选文件，请确认题号、归属及续页完整；程序不会猜测漏拍页。');
  return {tasks,warnings};
}

export function validateSettings(settings){
  const expected=Object.keys(DEFAULT_SETTINGS);
  if(!settings||Object.keys(settings).length!==expected.length||expected.some(k=>!Object.hasOwn(settings,k)))fail('运行设置缺失或含未知字段。');
  for(const k of ['budgetCny','requestReserveCny'])if(finite(settings[k],k)<=0)fail('预算、单次预留和速度须大于0。');
  if(!Number.isInteger(settings.concurrency)||settings.concurrency<1||settings.concurrency>4||settings.requestReserveCny>settings.budgetCny)fail('并发须为1至4的整数，单次预留不能超过预算。');
  if(settings.reasoning!=='medium'||settings.outputTokens!==8000)fail('当前版本仅支持统一的medium与8000输出设置。');
  return settings;
}
const isPDFJob=job=>job?.inputMode==='student_pdf';
const isStudentId=id=>typeof id==='string'&&/^\d{1,32}$/.test(id);
const identityStates=new Set(['pending','running','done','error','uncertain']);
const mappingStates=new Set(['ready','pending','conflict','missing_id','duplicate','roster_mismatch','input_error']);
function validRoster(roster){
  if(!Array.isArray(roster))fail('名单应为学号列表。');
  const ids=roster.map(id=>String(id).trim());
  if(ids.some(id=>!isStudentId(id))||new Set(ids).size!==ids.length)fail('名单应填写不重复的纯数字学号。');
  return ids;
}
function pageSnapshot(p){return p?{page_id:p.page_id,path:p.path,sha256:p.sha256,mime:p.mime,size:p.size,...(p.sourcePage===undefined?{}:{sourcePage:p.sourcePage})}:null;}
function documentSnapshot(d){
  return {id:d.id,path:d.path,sha256:d.sha256,size:d.size,pageCount:d.pageCount,expectedPageCount:d.expectedPageCount,filenameStudentId:d.filenameStudentId,inputError:d.inputError||'',cover:pageSnapshot(d.cover),answerPages:d.answerPages.map(pageSnapshot),identityState:d.identityState,identityResult:clone(d.identityResult),studentId:d.studentId,name:d.name,nameSource:d.nameSource,mappingStatus:d.mappingStatus,identityWarnings:[...d.identityWarnings],identityError:d.identityError||'',attempts:d.attempts.map(copyAttempt),identityReview:clone(d.identityReview),identityHistory:clone(d.identityHistory)};
}
export function refreshIdentityMappings(job){
  if(!isPDFJob(job))return job;
  const grouped=new Map();
  for(const doc of job.documents){
    const r=doc.identityResult,manual=doc.identityReview;
    doc.name=manual?manual.name:(r?.name_status==='readable'?r.name:null);
    doc.nameSource=manual?'manual':r?.name_status==='readable'?'ocr':'unreadable';
    doc.identityWarnings=manual?[]:[...(r?.warnings||[])];
    const ocrId=r?.student_id_status==='readable'?r.student_id:null;
    doc.studentId=manual?.studentId||doc.filenameStudentId||ocrId||null;
    if(doc.inputError)doc.mappingStatus='input_error';
    else if(!manual&&doc.identityState!=='done')doc.mappingStatus='pending';
    else if(!manual&&doc.filenameStudentId&&ocrId&&doc.filenameStudentId!==ocrId){doc.mappingStatus='conflict';doc.identityWarnings.push('文件名学号与首页识别学号不一致。');}
    else if(!doc.studentId){doc.mappingStatus='missing_id';doc.identityWarnings.push('学号未能确定，请查看首页补充。');}
    else if(job.roster.length&&!job.roster.includes(doc.studentId)){doc.mappingStatus='roster_mismatch';doc.identityWarnings.push('该学号不在应收名单中。');}
    else doc.mappingStatus='ready';
    if(!manual&&!doc.filenameStudentId&&ocrId)doc.identityWarnings.push('文件未按学号命名，已采用首页识别学号。');
    if(!manual&&doc.filenameStudentId&&r&&!ocrId)doc.identityWarnings.push('首页学号未能辨认，当前采用文件名学号。');
    if(!doc.name&&(doc.identityState==='done'||manual))doc.identityWarnings.push(manual?'姓名未填写，姓名列留空，可按需补充。':'姓名未能辨认，姓名列留空，可按需补充。');
    if(doc.studentId){if(!grouped.has(doc.studentId))grouped.set(doc.studentId,[]);grouped.get(doc.studentId).push(doc);}
  }
  for(const docs of grouped.values())if(docs.length>1)for(const doc of docs){doc.mappingStatus='duplicate';doc.identityWarnings.push('多份PDF对应同一学号，请核对后更正，分数暂不采用。');}
  return job;
}
export function documentForTask(job,task){return isPDFJob(job)?job.documents.find(d=>d.id===task.studentId)||null:null;}
export function studentDisplay(job,task){
  const doc=documentForTask(job,task);
  return doc?{studentId:doc.studentId||'',name:doc.name||'',status:doc.mappingStatus,warnings:doc.identityWarnings,document:doc}:{studentId:task.studentId,name:'',status:'ready',warnings:[],document:null};
}
export function taskAdvice(job,task){
  const doc=documentForTask(job,task);
  if(doc&&doc.mappingStatus!=='ready')return {scores:null,total:null,source:'unresolved',flags:['IDENTITY_'+doc.mappingStatus.toUpperCase()]};
  return advice(task);
}
function validateIdentityReview(review){
  if(!review||!isStudentId(review.studentId)||(review.name!==null&&(typeof review.name!=='string'||!review.name.trim()||review.name!==review.name.trim()||review.name.length>120||/[\u0000-\u001f\u007f]/.test(review.name)))||typeof review.at!=='string'||!Number.isFinite(Date.parse(review.at)))fail('身份修改记录无效。');
}
export function resolveStudentIdentity(job,docId,{studentId,name}){
  const doc=job.documents?.find(d=>d.id===docId);if(!isPDFJob(job)||!doc)fail('没有找到这份PDF。');
  if(!doc.file&&!doc.cover?.file)fail('请先重新选择原PDF，再核对身份。');
  const review={studentId:typeof studentId==='string'?studentId.trim():studentId,name:typeof name==='string'?(name.trim()||null):name,at:new Date().toISOString()};
  validateIdentityReview(review);doc.identityReview=review;doc.identityHistory.push(clone(review));doc.identityState='done';doc.identityError='';refreshIdentityMappings(job);return doc;
}
export function retryStudentIdentity(job,docId,consent=false){
  const doc=job.documents?.find(d=>d.id===docId);if(!isPDFJob(job)||!doc)fail('没有找到这份PDF。');
  if(!doc.cover||doc.inputError)fail('这份PDF缺少可读取的身份页，请修正材料后建立新批次。');
  if(doc.identityReview||!['error','uncertain'].includes(doc.identityState))fail('该身份请求没有可重试的失败记录。');
  if(doc.attempts.some(a=>a.costCny===null)&&!consent)fail('身份请求费用未定，重试可能再次计费，请先确认。');
  doc.identityState='pending';doc.identityError='';refreshIdentityMappings(job);return doc;
}
export async function createStudentPDFJob(pack,files,settings={},roster=[]){
  validatePack(pack);const merged={...DEFAULT_SETTINGS,...settings};validateSettings(merged);
  const validatedRoster=validRoster(roster);
  const expected=pack.questions.map((q,i)=>'Q'+(i+1));
  if(pack.questions.some((q,i)=>q.question_id!==expected[i]))fail('整份PDF模式要求规则题号按Q1、Q2等连续顺序排列；第2页对应Q1。');
  const {inspectStudentPDFs}=await import('./student-pdf.mjs');
  const indexed=await inspectStudentPDFs(files,pack.questions.length);
  if(!indexed.documents.length)fail('没有可登记的学生PDF。');
  const documents=indexed.documents.map(d=>({...d,expectedPageCount:pack.questions.length+1,identityState:'pending',identityResult:null,studentId:null,name:null,nameSource:'unreadable',mappingStatus:'pending',identityWarnings:[],identityError:'',attempts:[],identityReview:null,identityHistory:[]}));
  const tasks=[];
  for(const d of documents)for(const [i,question] of pack.questions.entries()){
    const pages=!d.inputError&&d.answerPages[i]?[d.answerPages[i]]:[];
    tasks.push({id:d.id+'::'+question.question_id,studentId:d.id,questionId:question.question_id,question,pages,inputComplete:pages.length===1,state:pages.length?'ready':'input_missing',result:null,review:null,reviewHistory:[],attempts:[],error:pages.length?'':d.inputError||'缺少该题对应的PDF页。'});
  }
  const job={id:uuid(),pack,packHash:await hashJSON(pack),pipelineVersion:VERSION,settings:merged,settingsHash:await hashJSON(merged),tasks,warnings:indexed.warnings,inputMode:'student_pdf',roster:validatedRoster,documents,preparationAttempts:[],spentCny:0,heldCny:0,demo:pack.demo};
  if(!job.roster.length)job.warnings.push('未提供应收名单，无法发现整份PDF未收到的同学。');
  refreshIdentityMappings(job);return job;
}
function validatePDFPage(p,label){
  if(!p||p.page_id!=='P1'||typeof p.path!=='string'||normalizedPath({name:p.path})!==p.path||!SHA.test(p.sha256)||p.mime!=='application/pdf'||finite(p.size,label)<=0||p.size>MAX_PAGE||!Number.isSafeInteger(p.sourcePage)||p.sourcePage<1)fail(label+'登记无效。');
  delete p.file;
}
function validatePDFDocuments(data){
  if(data.pack.questions.some((q,i)=>q.question_id!=='Q'+(i+1)))fail('PDF规则题号必须按Q1、Q2等连续顺序排列。');
  if(!Array.isArray(data.documents)||!data.documents.length||data.documents.length>20000)fail('PDF登记列表无效。');
  data.roster=validRoster(data.roster);const ids=new Set(),paths=new Set();
  for(const d of data.documents){
    if(!identifier(d.id)||ids.has(d.id)||typeof d.path!=='string'||normalizedPath({name:d.path})!==d.path||(paths.has(d.path)&&!d.inputError))fail('PDF编号或路径重复。');
    ids.add(d.id);paths.add(d.path);
    if(typeof d.inputError!=='string'||d.inputError.length>5000||!Number.isFinite(d.size)||d.size<0||(d.sha256!==null&&!SHA.test(d.sha256))||(!d.inputError&&!SHA.test(d.sha256)))fail('PDF原件记录无效。');
    if(d.pageCount!==null&&(!Number.isSafeInteger(d.pageCount)||d.pageCount<0||d.pageCount>(d.inputError?100000:101)))fail('PDF页数记录无效。');
    const filenameMatch=/^(\d{1,32})\.pdf$/i.exec(d.path.split('/').at(-1));
    if(d.expectedPageCount!==data.pack.questions.length+1||d.filenameStudentId!==(filenameMatch?filenameMatch[1]:null))fail('PDF页数或文件名学号记录无效。');
    if(!Array.isArray(d.answerPages)||d.answerPages.length>100)fail('PDF作答页记录无效。');
    if(d.cover){validatePDFPage(d.cover,'身份页');if(d.cover.sourcePage!==1||d.cover.path!==d.id+'/page-001.pdf')fail('身份页必须来自PDF第1页。');}
    for(const [i,p] of d.answerPages.entries()){validatePDFPage(p,'作答页');if(p.sourcePage!==i+2||p.path!==d.id+'/page-'+String(i+2).padStart(3,'0')+'.pdf')fail('作答页与题号顺序不一致。');}
    if(!d.inputError&&(!d.cover||d.pageCount!==d.expectedPageCount||d.answerPages.length!==data.pack.questions.length))fail('完整PDF页数与题目不匹配。');
    if(!identityStates.has(d.identityState)||!mappingStates.has(d.mappingStatus)||!Array.isArray(d.identityWarnings)||d.identityWarnings.some(w=>typeof w!=='string')||!Array.isArray(d.identityHistory)||!Array.isArray(d.attempts))fail('PDF身份记录无效。');
    if((d.studentId!==null&&!isStudentId(d.studentId))||(d.name!==null&&(typeof d.name!=='string'||d.name.length>120))||!['ocr','manual','unreadable'].includes(d.nameSource)||typeof d.identityError!=='string')fail('身份显示记录无效。');
    if(d.identityResult!==null)validateIdentityResult(d.identityResult);
    if(d.identityReview){validateIdentityReview(d.identityReview);if(!d.identityHistory.length||canonical(d.identityReview)!==canonical(d.identityHistory.at(-1)))fail('身份修改历史不完整。');}
    d.identityHistory.forEach(validateIdentityReview);
    for(const a of d.attempts){
      if(typeof a.id!=='string'||!a.id||a.kind!=='identity'||!['in_flight','response_saved','done','error','uncertain'].includes(a.state))fail('身份请求记录无效。');
      finite(a.reservedCny,'身份费用预留');if(a.costCny!==null)finite(a.costCny,'身份请求费用');
      if(a.state==='done')validateIdentityResult(a.response?.identity);
      if(typeof a.response?.estimatedCny==='number'&&Number.isFinite(a.response.estimatedCny)&&a.response.estimatedCny>=0&&a.costCny!==a.response.estimatedCny)fail('身份请求费用与已保存响应不一致。');
      if(a.state==='in_flight'){a.state='uncertain';a.uncertain=true;if(!d.identityReview){d.identityState='uncertain';d.identityError='上次身份请求中断，可能已计费，请明确确认后重试。';}}
    }
    if(d.identityResult&&!d.attempts.some(a=>a.state==='done'&&canonical(a.response.identity)===canonical(d.identityResult)))fail('身份识别与保存的响应不一致。');
    if(d.identityState==='done'&&!d.identityResult&&!d.identityReview)fail('完成的身份缺少识别或修改依据。');
    delete d.file;
  }
  refreshIdentityMappings(data);
}
function validatePDFTaskBindings(job){
  const docs=new Map(job.documents.map(d=>[d.id,d]));
  for(const t of job.tasks){
    const d=docs.get(t.studentId),i=job.pack.questions.findIndex(q=>q.question_id===t.questionId);if(!d)fail('任务引用未登记的PDF。');
    const expected=d.inputError?[]:[d.answerPages[i]];
    if(canonical(t.pages.map(pageSnapshot))!==canonical(expected.map(pageSnapshot)))fail('任务作答页与对应PDF页不一致。');
  }
  if(job.tasks.length!==job.documents.length*job.pack.questions.length)fail('PDF任务没有完整覆盖。');
}
async function rebindPDFDocuments(job,files){
  const {inspectStudentPDFs}=await import('./student-pdf.mjs');const indexed=await inspectStudentPDFs(files,job.pack.questions.length);
  if(indexed.documents.length!==job.documents.length)fail('重新选择的PDF数量与原记录不同。');
  const byId=new Map(indexed.documents.map(d=>[d.id,d]));
  for(const old of job.documents){
    const fresh=byId.get(old.id);if(!fresh||old.path!==fresh.path||old.sha256!==fresh.sha256||old.size!==fresh.size||old.pageCount!==fresh.pageCount||old.inputError!==(fresh.inputError||'')||canonical(pageSnapshot(old.cover))!==canonical(pageSnapshot(fresh.cover))||canonical(old.answerPages.map(pageSnapshot))!==canonical(fresh.answerPages.map(pageSnapshot)))fail('重新选择的PDF内容、页数或路径已改变：'+old.path);
  }
  for(const d of job.documents){const fresh=byId.get(d.id);d.file=fresh.file;if(d.cover)d.cover.file=fresh.cover.file;for(let i=0;i<d.answerPages.length;i++)d.answerPages[i].file=fresh.answerPages[i].file;}
  for(const t of job.tasks){const d=byId.get(t.studentId),i=job.pack.questions.findIndex(q=>q.question_id===t.questionId);if(t.pages.length)t.pages[0].file=d.answerPages[i].file;}
  return job;
}
function preservePDFHandles(latest,previous){
  if(!isPDFJob(latest)||!isPDFJob(previous))return;
  const docs=new Map(previous.documents.map(d=>[d.id,d]));
  for(const d of latest.documents){const old=docs.get(d.id);if(!old||old.sha256!==d.sha256||old.path!==d.path)continue;d.file=old.file;if(d.cover&&old.cover?.sha256===d.cover.sha256)d.cover.file=old.cover.file;for(let i=0;i<d.answerPages.length;i++)if(old.answerPages[i]?.sha256===d.answerPages[i].sha256)d.answerPages[i].file=old.answerPages[i].file;}
}

export async function createJob(pack,files,settings={},roster=[]){
  validatePack(pack);const merged={...DEFAULT_SETTINGS,...settings};validateSettings(merged);
  const indexed=await indexAnswers(files,pack,roster);
  return {id:uuid(),pack,packHash:await hashJSON(pack),pipelineVersion:VERSION,settings:merged,settingsHash:await hashJSON(merged),tasks:indexed.tasks,warnings:indexed.warnings,preparationAttempts:[],spentCny:0,heldCny:0,demo:pack.demo};
}
const clone=value=>JSON.parse(JSON.stringify(value));
function copyAttempt(a){
  const keys=['id','kind','state','reservedCny','costCny','sentAt','finishedAt','requestId','responseId','usage','response','raw','error','uncertain'];
  return Object.fromEntries(keys.filter(k=>a[k]!==undefined).map(k=>[k,clone(a[k])]));
}
// Only recover the latest attempt: an interrupted or failed newer request may
// refer to different teaching materials, so an older draft must not reappear.
export function restorePreparationDraft(attempts,{documentHashes}={}){
  if(!Array.isArray(attempts)||!attempts.length)return null;
  const latest=attempts.at(-1);
  if(latest?.kind!=='prepare'||latest.state!=='done')return null;
  try{
    if(documentHashes!==undefined){
      const roles=['paper','solution','rubric'],stored=latest.response?.documentHashes;
      const valid=hashes=>hashes&&typeof hashes==='object'&&!Array.isArray(hashes)&&Object.keys(hashes).length===roles.length&&roles.every(role=>typeof hashes[role]==='string'&&SHA.test(hashes[role]));
      if(!valid(documentHashes)||!valid(stored)||roles.some(role=>stored[role]!==documentHashes[role]))return null;
    }
    const {pack,warnings}=latest.response||{};
    validatePack(pack,{draft:true});
    if(pack.demo||pack.approved_by!==''||!Array.isArray(warnings)||warnings.length>100||warnings.some(w=>typeof w!=='string'||!w.trim()||w.length>2000))return null;
    // Keep only the draft and its blockers, never arbitrary response metadata.
    return {pack:clone(pack),warnings:clone(warnings),ready:warnings.length===0};
  }catch{return null;}
}
export function snapshotJob(job){
  return {formatVersion:3,...(isPDFJob(job)?{inputMode:'student_pdf',roster:[...job.roster],documents:job.documents.map(documentSnapshot)}:{}),id:job.id,pack:clone(job.pack),packHash:job.packHash,pipelineVersion:job.pipelineVersion,settings:clone(job.settings),settingsHash:job.settingsHash,demo:job.demo,warnings:clone(job.warnings||[]),preparationAttempts:(job.preparationAttempts||[]).map(copyAttempt),spentCny:job.spentCny,heldCny:job.heldCny,tasks:job.tasks.map(t=>({id:t.id,studentId:t.studentId,questionId:t.questionId,question:clone(t.question),inputComplete:t.inputComplete,state:t.state,error:t.error||'',pages:t.pages.map(pageSnapshot),result:clone(t.result),review:clone(t.review),reviewHistory:clone(t.reviewHistory||[]),attempts:t.attempts.map(copyAttempt)}))};
}
function validatePreparation(attempts){
  if(!Array.isArray(attempts)||attempts.length>1000)fail('规则整理请求记录无效。');
  const ids=new Set();
  return attempts.map(source=>{
    if(!source||typeof source.id!=='string'||!source.id||ids.has(source.id)||!['in_flight','response_saved','done','error','uncertain'].includes(source.state))fail('规则整理请求编号或状态无效。');
    ids.add(source.id);finite(source.reservedCny,'规则整理预留');if(source.costCny!==null)finite(source.costCny,'规则整理费用');
    if(source.kind!=='prepare')fail('规则整理请求通道不正确。');
    const a=copyAttempt({...source,kind:'prepare'});
    if(a.state==='in_flight'){a.state='uncertain';a.uncertain=true;}
    return a;
  });
}
function ledgerTotals(job){
  const attempts=[...(job.preparationAttempts||[]),...(job.documents||[]).flatMap(d=>d.attempts),...job.tasks.flatMap(t=>t.attempts)];
  if(new Set(attempts.map(a=>a.id)).size!==attempts.length)fail('费用账本包含重复请求编号。');
  return {spentCny:money(attempts.reduce((n,a)=>n+(a.costCny??0),0)),heldCny:money(attempts.reduce((n,a)=>n+(a.costCny===null?a.reservedCny:0),0))};
}
export function attachPreparation(job,attempts){
  const validated=validatePreparation(attempts),ids=new Set(validated.map(a=>a.id));
  if((job.preparationAttempts||[]).some(a=>!ids.has(a.id)))fail('不能移除已登记的规则整理费用。');
  job.preparationAttempts=validated;Object.assign(job,ledgerTotals(job));return job;
}
async function openDB(){
  if(!globalThis.indexedDB)fail('此浏览器无法保存批改进度，请使用允许本地存储的浏览器窗口。');
  return new Promise((resolve,reject)=>{const r=indexedDB.open('grading-assistant-web',1);r.onupgradeneeded=()=>r.result.createObjectStore('jobs');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('无法打开本地进度库。'));});
}
export async function saveJob(job){
  const data=snapshotJob(job),db=await openDB();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction('jobs','readwrite'),store=tx.objectStore('jobs');store.put(data,'job:'+job.id);store.put(job.id,'last');tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(new Error('进度保存失败；已停止继续调用，请检查浏览器存储空间。'));});}finally{db.close();}
}
export async function loadJob(jobId){
  const db=await openDB();let data;
  try{data=await new Promise((resolve,reject)=>{const store=db.transaction('jobs','readonly').objectStore('jobs'),r=store.get(jobId?'job:'+jobId:'last');r.onsuccess=()=>{if(!jobId&&typeof r.result==='string'){const saved=store.get('job:'+r.result);saved.onsuccess=()=>resolve(saved.result);saved.onerror=()=>reject(new Error('无法读取保存的进度。'));}else resolve(r.result);};r.onerror=()=>reject(new Error('无法读取保存的进度。'));});}finally{db.close();}
  return data?importBackup(data):null;
}
export async function clearLastJob(){
  const db=await openDB();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction('jobs','readwrite');tx.objectStore('jobs').delete('last');tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(new Error('无法关闭当前任务入口。'));});}finally{db.close();}
}

export async function importBackup(raw){
  const data=typeof raw==='string'?JSON.parse(raw):clone(raw);
  if(data?.formatVersion!==3||typeof data.id!=='string'||!data.id||data.id.length>200||data.pipelineVersion!==VERSION)fail('当前版本仅支持新批次，请使用新版规则建立批次；旧备份不会被转换。');
  validatePack(data.pack);validateSettings(data.settings);
  if(isPDFJob(data))validatePDFDocuments(data);else if(data.inputMode!==undefined)fail('备份输入模式无效。');
  data.preparationAttempts=validatePreparation(data.preparationAttempts||[]);
  if(data.packHash!==await hashJSON(data.pack)||data.settingsHash!==await hashJSON(data.settings)||data.demo!==data.pack.demo)fail('规则、参数或版本校验失败。');
  for(const key of ['spentCny','heldCny'])finite(data[key],key);
  if(!Array.isArray(data.tasks)||!data.tasks.length||data.tasks.length>20000)fail('备份任务列表无效。');
  const qs=new Map(data.pack.questions.map(q=>[q.question_id,q])),pairs=new Set(),students=new Set(),paths=new Set(),attemptIds=new Set();
  for(const t of data.tasks){
    if(!identifier(t.studentId)||!qs.has(t.questionId)||t.id!==t.studentId+'::'+t.questionId||pairs.has(t.id))fail('任务编号重复或无效。');
    pairs.add(t.id);students.add(t.studentId);
    if(canonical(t.question)!==canonical(qs.get(t.questionId))||typeof t.inputComplete!=='boolean'||!STATES.has(t.state))fail('任务规则或状态无效。');
    if(!Array.isArray(t.pages)||t.pages.length>30||t.inputComplete!==!!t.pages.length)fail('原图登记不完整。');
    for(const [i,p] of t.pages.entries()){
      if(p.page_id!=='P'+(i+1)||typeof p.path!=='string'||normalizedPath({name:p.path})!==p.path||paths.has(p.path)||!SHA.test(p.sha256)||!['image/png','image/jpeg','image/webp','application/pdf'].includes(p.mime)||finite(p.size,'文件大小')<=0||p.size>MAX_PAGE)fail('原图登记不合法。');
      paths.add(p.path);delete p.file;
    }
    if(t.pages.reduce((n,p)=>n+p.size,0)>MAX_TASK)fail('登记图像超过单题大小限制。');
    if(!Object.hasOwn(t,'result')||Object.hasOwn(t,'results'))fail('评分结果字段无效。');
    if(t.result!==null)validateResult(t.result,t.question,t.pages.map(p=>p.page_id));
    if(!Array.isArray(t.reviewHistory)||!Array.isArray(t.attempts))fail('修改或请求记录不完整。');
    for(const r of t.reviewHistory)validateReview(r,t.question);
    if(t.review){validateReview(t.review,t.question);if(!t.reviewHistory.length||canonical(t.review)!==canonical(t.reviewHistory.at(-1)))fail('修改历史不完整。');}
    for(const a of t.attempts){
      if(typeof a.id!=='string'||attemptIds.has(a.id)||a.kind!=='grade'||!['in_flight','response_saved','done','error','uncertain'].includes(a.state))fail('请求记录无效。');
      attemptIds.add(a.id);finite(a.reservedCny,'预留费用');if(a.costCny!==null)finite(a.costCny,'请求费用');
      if(a.state==='done')validateResult(a.response?.result,t.question,t.pages.map(p=>p.page_id));
      if(typeof a.response?.estimatedCny==='number'&&Number.isFinite(a.response.estimatedCny)&&a.response.estimatedCny>=0&&a.costCny!==a.response.estimatedCny)fail('请求费用与响应不一致。');
      if(a.state==='in_flight'){a.state='uncertain';a.uncertain=true;t.state='uncertain';t.error='上次请求在途时页面关闭，可能已计费；请明确确认后重试。';}
    }
    if(t.result&&!t.attempts.some(a=>a.state==='done'&&canonical(a.response?.result)===canonical(t.result)))fail('评分结果与已保存响应不一致。');
    if(t.state==='done'&&!t.result&&!t.review)fail('完成的题目没有评分结果。');
    if(t.review&&!t.inputComplete)fail('缺图任务不能带有人工分数。');
  }
  for(const s of students)for(const q of qs.keys())if(!pairs.has(s+'::'+q))fail('备份漏掉该学生的题目。');
  if(isPDFJob(data))validatePDFTaskBindings(data);
  const totals=ledgerTotals(data);
  if(Math.abs(totals.spentCny-data.spentCny)>1e-6||Math.abs(totals.heldCny-data.heldCny)>1e-6)fail('备份费用与请求账本不一致。');
  // Projection removes unrecognized fields (including accidentally pasted keys).
  return snapshotJob(data);
}

export async function restoreBackupSafely(raw,{load=loadJob,persist=saveJob,locks=globalThis.navigator?.locks}={}){
  const imported=await importBackup(raw);
  if(!locks?.request)fail('当前浏览器不支持安全的独占任务锁，请使用新版Chrome或Edge。');
  return locks.request('grading-runner',{mode:'exclusive',ifAvailable:true},async runnerLock=>{
    if(!runnerLock)fail('另一个页面正在运行批改，请先暂停，再恢复备份。');
    return locks.request('grading-job:'+imported.id,{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock)fail('此批次正在另一个页面运行，请先暂停，再恢复备份。');
      const local=await load(imported.id);
      if(local){const current=await importBackup(snapshotJob(local));await persist(current);return {job:current,usedLocal:true};}
      await persist(imported);return {job:imported,usedLocal:false};
    });
  });
}

export async function rebindJob(job,files,{load=globalThis.indexedDB?loadJob:async()=>null}={}){
  const latest=await load(job.id);
  if(latest){
    if(latest.id!==job.id||latest.packHash!==job.packHash||latest.settingsHash!==job.settingsHash)fail('重新绑定的已保存任务版本不同。');
    Object.assign(job,latest);
  }
  if(isPDFJob(job))return rebindPDFDocuments(job,files);
  const indexed=await indexAnswers(files,job.pack,[...new Set(job.tasks.map(t=>t.studentId))]);
  const byId=new Map(indexed.tasks.map(t=>[t.id,t]));
  for(const t of job.tasks){const candidate=byId.get(t.id);if(!candidate||candidate.pages.length!==t.pages.length)fail('重新选择的文件夹与原记录页数不同。');
    for(let i=0;i<t.pages.length;i++){const a=t.pages[i],b=candidate.pages[i];if(a.path!==b.path||a.sha256!==b.sha256||a.mime!==b.mime||a.size!==b.size)fail('重新选择的原图或相对路径已改变：'+a.path);}
  }
  for(const t of job.tasks)for(let i=0;i<t.pages.length;i++)t.pages[i].file=byId.get(t.id).pages[i].file;
  return job;
}
function validateReview(review,question){
  if(!review||typeof review.reviewer!=='string'||!review.reviewer.trim()||typeof review.reason!=='string'||review.reason.length>10000||typeof review.at!=='string'||!Number.isFinite(Date.parse(review.at)))fail('人工复核记录不完整。');
  validateScores(review.scores,question);
}
export function reviewTask(task,scores,reviewer,reason=''){
  if(!task.inputComplete||!task.pages.length||task.pages.some(p=>!p.file))fail('请先重新选择原图，再作人工改分。');
  const review={scores:clone(scores),reviewer:typeof reviewer==='string'?reviewer.trim():reviewer,reason:typeof reason==='string'?reason.trim():reason,at:new Date().toISOString()};
  validateReview(review,task.question);task.review=review;task.reviewHistory.push(clone(review));return task;
}
export function requeueTask(task,ackUncertain=false){
  if(!task.inputComplete)fail('缺页任务不能重试，请整理后建立新任务。');
  if(task.review||!['error','uncertain'].includes(task.state))fail('该题无可重试的失败请求。');
  if(task.attempts.some(a=>a.costCny===null)&&!ackUncertain)fail('该题有费用未定的请求，重试可能再次计费。');
  task.error='';task.state='ready';return task;
}

function redact(value,key){
  if(typeof value==='string')return (key?value.split(key).join('[REDACTED]'):value).replace(/sk-[A-Za-z0-9_-]{8,}/g,'[REDACTED]');
  if(Array.isArray(value))return value.map(v=>redact(v,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['apiKey','api_key','authorization','Authorization'].includes(k)).map(([k,v])=>[k,redact(v,key)]));
  return value;
}
function settle(job,attempt,response,knownFailure=false){
  const cost=response.estimatedCny;
  if(typeof cost==='number'&&Number.isFinite(cost)&&cost>=0){attempt.costCny=cost;job.spentCny=money(job.spentCny+cost);job.heldCny=money(job.heldCny-attempt.reservedCny);}
  else if(knownFailure){attempt.costCny=0;job.heldCny=money(job.heldCny-attempt.reservedCny);}
  attempt.usage=response.usage||null;attempt.requestId=response.requestId||attempt.id;attempt.responseId=response.responseId||'';attempt.finishedAt=new Date().toISOString();
}
async function recoverResponses(job,persist){
  let changed=false;
  for(const task of job.tasks)for(const attempt of task.attempts){
    if(attempt.state==='in_flight'){attempt.state='uncertain';attempt.uncertain=true;task.state='uncertain';task.error='上次请求中断，可能已计费，请核对后明确重试。';changed=true;}
    if(attempt.state==='response_saved'){
      try{validateResult(attempt.response.result,task.question,task.pages.map(p=>p.page_id));task.result=clone(attempt.response.result);attempt.state='done';task.error='';task.state='done';}
      catch{attempt.state='error';task.state='error';task.error='已保存的响应未通过校验，请按需复核。';}
      changed=true;
    }
  }
  for(const doc of job.documents||[])for(const attempt of doc.attempts){
    if(attempt.state==='in_flight'){attempt.state='uncertain';attempt.uncertain=true;if(!doc.identityReview){doc.identityState='uncertain';doc.identityError='上次身份请求中断，可能已计费，请核对后明确重试。';}changed=true;}
    if(attempt.state==='response_saved'){
      try{validateIdentityResult(attempt.response.identity);doc.identityResult=clone(attempt.response.identity);attempt.state='done';doc.identityState='done';doc.identityError='';}
      catch{attempt.state='error';doc.identityState='error';doc.identityError='身份识别结果未通过校验，请查看首页或按需重试。';}
      changed=true;
    }
  }
  refreshIdentityMappings(job);if(changed)await persist(job);
}
function exportPDFCSV(job){
  refreshIdentityMappings(job);
  const qids=job.pack.questions.map(q=>q.question_id),index=new Map(job.tasks.map(t=>[t.id,t]));
  const rows=[['学号','姓名','姓名来源','姓名识别状态','身份状态','原PDF文件',...qids,'建议总分','状态','分数来源','评分提示']];
  const labels={ready:'已对应',pending:'身份未完成',conflict:'学号冲突',missing_id:'待补学号',duplicate:'学号重复',roster_mismatch:'名单外学号',input_error:'PDF材料异常'};
  for(const doc of [...job.documents].sort((a,b)=>(a.studentId||a.path).localeCompare(b.studentId||b.path))){
    const items=qids.map(q=>taskAdvice(job,index.get(doc.id+'::'+q))),complete=doc.mappingStatus==='ready'&&items.every(a=>a.total!==null);
    rows.push([doc.studentId||'',doc.name||'',doc.nameSource==='manual'?'人工填写':doc.nameSource==='ocr'?'首页手写识别':'未识别',doc.name?'已识别或填写':'待补充',labels[doc.mappingStatus]||doc.mappingStatus,doc.path,...items.map(a=>a.total??''),complete?sumScores(items.map(a=>a.total)):'',(job.demo?'合成演示 · ':'')+(complete?'AI建议成绩（非正式）':'未完成（未知分数留空）'),items.map((a,i)=>qids[i]+':'+a.source).join(';'),[doc.inputError,doc.identityError,...doc.identityWarnings,...items.flatMap((a,i)=>a.flags.map(f=>qids[i]+':'+f))].filter(Boolean).join(';')]);
  }
  const received=new Set(job.documents.map(d=>d.studentId).filter(Boolean));
  for(const id of job.roster)if(!received.has(id))rows.push([id,'','未识别','未收到PDF','未收到PDF','',...qids.map(()=>''),'','未完成（未知分数留空）','','应收名单中未发现对应PDF。']);
  return '\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
export async function studentPDFDemoJob(){
  const {PDFDocument,StandardFonts,rgb}=await import('pdf-lib');const original=await demoJob();const files=[];
  for(const [i,id] of ['9000000001','9000000002'].entries()){
    const pdf=await PDFDocument.create();pdf.setCreationDate(new Date('2000-01-01T00:00:00Z'));pdf.setModificationDate(new Date('2000-01-01T00:00:00Z'));pdf.setTitle('Synthetic grading demonstration');pdf.setAuthor('');pdf.setProducer('grading-demo');pdf.setCreator('grading-demo');const font=await pdf.embedFont(StandardFonts.Helvetica);
    for(let p=0;p<3;p++){const page=pdf.addPage([595,842]);page.drawText('DEMO - Synthetic example only',{x:50,y:750,size:22,font,color:rgb(.15,.35,.28)});page.drawText(p===0?'Identity cover / Student '+id:'Answer page Q'+p,{x:50,y:700,size:18,font});page.drawText(p===0?'Name: Demo '+(i+1):'Fixed synthetic answer; not a real examination.',{x:50,y:650,size:16,font});}
    files.push(new File([await pdf.save({useObjectStreams:false})],id+'.pdf',{type:'application/pdf'}));
  }
  return createStudentPDFJob(original.pack,files);
}

export async function runJob(job,{apiKey='',onChange=()=>{},shouldStop=()=>false,isOnline=()=>globalThis.navigator?.onLine!==false,fetcher=globalThis.fetch,persist=saveJob,load=loadJob,locks=globalThis.navigator?.locks,clock=()=>Date.now()}={}){
  validatePack(job.pack);validateSettings(job.settings);
  if(job.pipelineVersion!==VERSION||job.packHash!==await hashJSON(job.pack)||job.settingsHash!==await hashJSON(job.settings)||job.demo!==job.pack.demo)fail('考试规则、运行参数或程序版本已改变，请建立新任务。');
  if(!job.demo&&(!apiKey||typeof apiKey!=='string'||/\s/.test(apiKey)))fail('请填写本次使用的 API key。');
  if(!locks?.request)fail('当前浏览器不支持安全的独占任务锁，请使用新版Chrome或Edge。');
  return locks.request('grading-runner',{mode:'exclusive',ifAvailable:true},async runnerLock=>{
    if(!runnerLock)fail('另一个页面正在运行批改，请先暂停，避免多批次重复提交。');
    return locks.request('grading-job:'+job.id,{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock)fail('此批次已在另一个页面运行，请勿重复启动。');
      const latest=await load(job.id);
      if(latest){
        if(latest.id!==job.id||latest.packHash!==job.packHash||latest.settingsHash!==job.settingsHash||latest.pipelineVersion!==VERSION)fail('已保存任务与当前页面不同，请重新载入。');
        const bound=new Map(job.tasks.flatMap(t=>t.pages.filter(p=>p.file).map(p=>[p.path,p])));
        for(const t of latest.tasks)for(const p of t.pages){const previous=bound.get(p.path);if(previous?.sha256===p.sha256)p.file=previous.file;}
        preservePDFHandles(latest,job);Object.assign(job,latest);
      }
      await recoverResponses(job,persist);
      let requests=0,halted=false,reason='',firstError=null,writeTail=Promise.resolve();
      const stop=(message,error=null)=>{halted=true;if(!reason)reason=message;if(error&&!firstError)firstError=error;};
      const stopped=()=>{
        if(shouldStop())stop('已暂停；在途请求完成后保存。');
        if(!job.demo&&!isOnline())stop('网络已断开，已暂停新请求；联网后可手动继续尚未提交的任务。');
        return halted;
      };
      // Every mutation and durable snapshot uses one queue. A delayed write can
      // never replace a newer completion, and no request precedes its saved reserve.
      const commit=fn=>{
        const operation=writeTail.then(async()=>{fn();try{await persist(job);}catch(error){stop('进度保存失败，已停止新请求。请下载当前进度并检查本机存储。',error);throw error;}finally{onChange(job);}});
        writeTail=operation.catch(()=>{});return operation;
      };
      const setState=(item,kind,state,error='')=>{if(kind==='identity'){item.identityState=state;item.identityError=error;refreshIdentityMappings(job);}else{item.state=state;item.error=error;}};
      const execute=async(item,kind,attempt,payload)=>{
        let response,status=200;
        try{
          if(job.demo)response=kind==='grade'?demoResponse(item,attempt.id):{identity:{name:item.filenameStudentId==='9000000001'?'演示甲':'演示乙',student_id:item.filenameStudentId,name_status:'readable',student_id_status:'readable',warnings:['合成演示：身份结果为固定模拟值。']},usage:{input_tokens:0,output_tokens:0},requestId:attempt.id,responseId:'demo-'+attempt.id,model:'DEMO',estimatedCny:0};
          else{
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),240000);
            try{const r=await fetcher('/api/'+kind,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':apiKey},body:JSON.stringify({...payload,requestId:attempt.id}),signal:controller.signal});status=r.status;response=redact(await r.json(),apiKey);if(!response||typeof response!=='object'||Array.isArray(response))response={error:'接口响应格式不完整，是否已计费不确定。',uncertain:true};}
            finally{clearTimeout(timer);}
          }
        }catch{
          stop('调用中断，已暂停；费用未定的请求不会自动重试。');
          try{await commit(()=>{attempt.state='uncertain';attempt.uncertain=true;attempt.error='调用中断，是否已计费不确定。';setState(item,kind,'uncertain',attempt.error);});}catch{}
          return;
        }
        const failed=status<200||status>=300||!!response.error;
        if(failed&&(response.uncertain||status>=500||[401,403,429].includes(status)||['QUOTA','AUTH','MISSING_KEY','SERVER_BUSY'].includes(response.code)))stop(response.error||'服务暂时不可用，已暂停新请求。');
        try{
          await commit(()=>{
            attempt.response=response;settle(job,attempt,response,failed&&response.uncertain===false);
            attempt.state=failed?(response.uncertain?'uncertain':'error'):'response_saved';
            if(failed){attempt.uncertain=!!response.uncertain;attempt.error=typeof response.error==='string'?response.error:'接口返回错误。';setState(item,kind,attempt.state,attempt.error);}
          });
        }catch{}
        if(failed)return;
        // Even after a storage failure, retain returned results in memory and
        // attempt to save each remaining completion; never abandon paid in-flight work.
        try{await commit(()=>{
          try{
            if(kind==='identity'){validateIdentityResult(response.identity);item.identityResult=clone(response.identity);}
            else{validateResult(response.result,item.question,item.pages.map(p=>p.page_id));item.result=clone(response.result);}
            attempt.state='done';setState(item,kind,'done');
          }catch{attempt.state='error';setState(item,kind,'error',kind==='identity'?'身份识别未通过完整性检查，请查看首页或按需重试。':'评分结果未通过完整性检查，分数保留未定。');}
        });}catch{}
      };
      const readPayload=async(item,kind)=>{
        if(kind==='identity'){
          if(!item.cover.file)fail('身份页尚未重新关联，请先选择原PDF文件夹。');
          const file=await readUpload(item.cover.file,'identity-page.pdf');if(file.sha256!==item.cover.sha256)fail('身份页内容已改变，请重新核对原PDF。');
          return {page:{...file,page_id:'P1'}};
        }
        if(item.pages.some(p=>!p.file))fail('原图尚未重新绑定，请先选择原来的答题卡文件夹。');
        const pages=[];for(const p of item.pages){const ext=p.path.split('.').pop(),file=await readUpload(p.file,'page-'+p.page_id.slice(1)+'.'+ext);if(file.sha256!==p.sha256)fail('原图已改变，已停止：'+p.path);pages.push({...file,page_id:p.page_id});}
        return {pack:job.pack,questionId:item.questionId,pages};
      };
      const runStage=async(items,kind)=>{
        let cursor=0;const active=new Set();
        while(cursor<items.length||active.size){
          while(cursor<items.length&&active.size<job.settings.concurrency&&!stopped()){
            const reserve=job.demo?0:job.settings.requestReserveCny;
            if(money(job.spentCny+job.heldCny+reserve)>job.settings.budgetCny){
              if(!active.size)stop('预算不足以预留下一次请求，已停止。',new Error('预算不足以预留下一次请求，已停止。'));
              break;
            }
            const item=items[cursor];let payload,attempt,registered=false;
            try{
              payload=await readPayload(item,kind);
              if(stopped())break;
              await commit(()=>{
                if(stopped())return;
                if(money(job.spentCny+job.heldCny+reserve)>job.settings.budgetCny)return;
                attempt={id:uuid(),kind,state:'in_flight',reservedCny:reserve,costCny:null,sentAt:new Date(clock()).toISOString(),uncertain:false};
                item.attempts.push(attempt);job.heldCny=money(job.heldCny+reserve);setState(item,kind,'running');registered=true;
              });
              if(!registered){if(!active.size&&!halted)stop('预算不足以预留下一次请求，已停止。',new Error('预算不足以预留下一次请求，已停止。'));break;}
              cursor++;
              if(stopped()){
                // A pause/disconnect while the reserve was saving is known not
                // to have sent a request. Clear that reserve rather than retry it.
                await commit(()=>{attempt.state='error';attempt.costCny=0;attempt.error='请求尚未发送，已暂停。';job.heldCny=money(job.heldCny-reserve);setState(item,kind,kind==='identity'?'pending':'ready');});
                break;
              }
              requests++;
              let promise;promise=execute(item,kind,attempt,payload).catch(error=>stop('请求处理失败，已停止新请求。',error)).finally(()=>active.delete(promise));active.add(promise);
            }catch(error){
              stop(error?.message||'材料读取或保存失败。',error);
              if(registered&&attempt){
                // Persistence failed before fetch. No charge can have occurred.
                try{await commit(()=>{attempt.state='error';attempt.costCny=0;attempt.error='请求未发送：保存失败。';job.heldCny=money(job.heldCny-reserve);setState(item,kind,kind==='identity'?'pending':'ready');});}catch{}
              }
              break;
            }
          }
          if(active.size)await Promise.race(active);else break;
        }
        await writeTail;
      };
      const identities=(job.documents||[]).filter(d=>!d.inputError&&d.cover&&!d.identityReview&&!d.identityResult&&!['error','uncertain','done'].includes(d.identityState));
      await runStage(identities,'identity');refreshIdentityMappings(job);
      if(!stopped())await runStage(job.tasks.filter(t=>t.inputComplete&&!t.review&&!t.result&&!['error','uncertain','input_missing'].includes(t.state)&&(!isPDFJob(job)||documentForTask(job,t)?.mappingStatus==='ready')),'grade');
      if(firstError)throw firstError;
      return {requests,paused:halted,reason};
    });
  });
}

function csvCell(v){const s=String(v??'');return '"'+((/^[\s]*[=+@-]/.test(s)?"'":'')+s).replaceAll('"','""')+'"';}
export function exportCSV(job){
  if(isPDFJob(job))return exportPDFCSV(job);
  const qids=job.pack.questions.map(q=>q.question_id),students=[...new Set(job.tasks.map(t=>t.studentId))].sort(),index=new Map(job.tasks.map(t=>[t.id,t]));
  const rows=[['学号或匿名号',...qids,'建议总分','状态','分数来源','评分提示']];
  for(const student of students){const items=qids.map(q=>advice(index.get(student+'::'+q)));const complete=items.every(a=>a.total!==null);rows.push([student,...items.map(a=>a.total??''),complete?sumScores(items.map(a=>a.total)):'',(job.demo?'合成演示 · ':'')+(complete?'AI建议成绩（非正式）':'未完成（未知分数留空）'),items.map((a,i)=>qids[i]+':'+a.source).join(';'),items.flatMap((a,i)=>a.flags.map(f=>qids[i]+':'+f)).join(';')]);}
  return '\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
function demoResponse(task,id){
  const result={question_id:task.questionId,status:'scored',criteria:task.question.criteria.map(c=>({criterion_id:c.criterion_id,awarded:Math.max(...c.allowed_scores),evidence_refs:task.pages.map(p=>p.page_id),reason:'【离线演示】固定合成结果，不代表实际学生表现。'})),flags:[],alternative_solution:false};
  return {result,usage:{input_tokens:0,output_tokens:0},requestId:id,responseId:'demo-'+id,model:'DEMO',raw:JSON.stringify(result),estimatedCny:0};
}
export async function demoJob(){
  const pack={exam_id:'DEMO',title:'合成演示（不是学生成绩）',version:'demo-1',demo:true,approved_by:'演示规则',policies:'仅演示软件流程。正式题目需教师确认真实规则。',questions:['Q1','Q2'].map(q=>({question_id:q,text:q==='Q1'?'演示：抛均匀硬币，求正面概率。':'演示：说明独立变量的方差相加。',solution:'此图仅为DEMO，分数是固定模拟结果。',max_score:5,criteria:[{criterion_id:'C1',description:'方法',allowed_scores:[0,1,2],requires:[]},{criterion_id:'C2',description:'结论',allowed_scores:[0,1.5,3],requires:[]}]}))};
  let blob;
  if(globalThis.document){const canvas=document.createElement('canvas');canvas.width=700;canvas.height=280;const ctx=canvas.getContext('2d');ctx.fillStyle='#faf9f5';ctx.fillRect(0,0,700,280);ctx.fillStyle='#1d4854';ctx.font='bold 64px sans-serif';ctx.fillText('DEMO',230,145);ctx.font='20px sans-serif';ctx.fillText('Synthetic example only',235,190);blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));}
  else{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nN8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));blob=new Blob([bytes],{type:'image/png'});}
  const files=[];for(const s of ['S001','S002'])for(const q of ['Q1','Q2'])files.push(new File([blob],s+'_'+q+'_01.png',{type:'image/png'}));
  return createJob(pack,files);
}
