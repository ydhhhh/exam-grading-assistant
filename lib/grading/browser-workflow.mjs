/** Browser-owned task ledger. No API key is ever part of a job or its backup. */
import {VERSION,MODEL,RESOURCE_LIMITS,validatePack,validateResult,validateScores,advice,sumScores} from './validation.mjs';

export const DEFAULT_SETTINGS=Object.freeze({budgetCny:100,requestsPerMinute:1,requestReserveCny:5,reasoning:'medium',outputTokens:8000});
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
    tasks.push({id:key,studentId,questionId:question.question_id,question,pages:pages.map((p,i)=>({page_id:'P'+(i+1),file:p.file,path:p.path,sha256:p.sha256,mime:p.mime,size:p.size})),inputComplete:!!pages.length,state:pages.length?'ready':'input_missing',results:{A:null,B:null},review:null,reviewHistory:[],attempts:[],error:pages.length?'':'缺少该题作答，分数留空。'});
  }
  if(!roster.length)warnings.push('未提供全班名单，能发现已收学生的缺题，但无法发现整份未收的学生。');
  warnings.push('页数来自所选文件，请确认题号、归属及续页完整；程序不会猜测漏拍页。');
  return {tasks,warnings};
}

export function validateSettings(settings){
  const expected=Object.keys(DEFAULT_SETTINGS);
  if(!settings||Object.keys(settings).length!==expected.length||expected.some(k=>!Object.hasOwn(settings,k)))fail('运行设置缺失或含未知字段。');
  for(const k of ['budgetCny','requestsPerMinute','requestReserveCny'])if(finite(settings[k],k)<=0)fail('预算、单次预留和速度须大于0。');
  if(settings.requestsPerMinute>60||settings.requestReserveCny>settings.budgetCny)fail('请求速度过高或单次预留超过预算。');
  if(settings.reasoning!=='medium'||settings.outputTokens!==8000)fail('当前版本仅支持统一的medium与8000输出设置。');
  return settings;
}
export async function createJob(pack,files,settings={},roster=[]){
  validatePack(pack);const merged={...DEFAULT_SETTINGS,...settings};validateSettings(merged);
  const indexed=await indexAnswers(files,pack,roster);
  return {id:uuid(),pack,packHash:await hashJSON(pack),pipelineVersion:VERSION,settings:merged,settingsHash:await hashJSON(merged),tasks:indexed.tasks,warnings:indexed.warnings,preparationAttempts:[],spentCny:0,heldCny:0,lastSendAt:0,demo:pack.demo};
}
const clone=value=>JSON.parse(JSON.stringify(value));
function copyAttempt(a){
  const keys=['id','lane','state','reservedCny','costCny','sentAt','finishedAt','requestId','responseId','usage','response','raw','error','uncertain'];
  return Object.fromEntries(keys.filter(k=>a[k]!==undefined).map(k=>[k,clone(a[k])]));
}
// Only recover the latest attempt: an interrupted or failed newer request may
// refer to different teaching materials, so an older draft must not reappear.
export function restorePreparationDraft(attempts){
  if(!Array.isArray(attempts)||!attempts.length)return null;
  const latest=attempts.at(-1);
  if(latest?.lane!=='prepare'||latest.state!=='done')return null;
  try{
    const {pack,warnings}=latest.response||{};
    validatePack(pack,{draft:true});
    if(pack.demo||pack.approved_by!==''||!Array.isArray(warnings)||warnings.length>100||warnings.some(w=>typeof w!=='string'||!w.trim()||w.length>2000))return null;
    // Keep only the draft and its blockers, never arbitrary response metadata.
    return {pack:clone(pack),warnings:clone(warnings),ready:warnings.length===0};
  }catch{return null;}
}
export function snapshotJob(job){
  return {formatVersion:1,id:job.id,pack:clone(job.pack),packHash:job.packHash,pipelineVersion:job.pipelineVersion,settings:clone(job.settings),settingsHash:job.settingsHash,demo:job.demo,warnings:clone(job.warnings||[]),preparationAttempts:(job.preparationAttempts||[]).map(copyAttempt),spentCny:job.spentCny,heldCny:job.heldCny,lastSendAt:job.lastSendAt||0,tasks:job.tasks.map(t=>({id:t.id,studentId:t.studentId,questionId:t.questionId,question:clone(t.question),inputComplete:t.inputComplete,state:t.state,error:t.error||'',pages:t.pages.map(p=>({page_id:p.page_id,path:p.path,sha256:p.sha256,mime:p.mime,size:p.size})),results:clone(t.results),review:clone(t.review),reviewHistory:clone(t.reviewHistory||[]),attempts:t.attempts.map(copyAttempt)}))};
}
function validatePreparation(attempts){
  if(!Array.isArray(attempts)||attempts.length>1000)fail('规则整理请求记录无效。');
  const ids=new Set();
  return attempts.map(source=>{
    if(!source||typeof source.id!=='string'||!source.id||ids.has(source.id)||!['in_flight','response_saved','done','error','uncertain'].includes(source.state))fail('规则整理请求编号或状态无效。');
    ids.add(source.id);finite(source.reservedCny,'规则整理预留');if(source.costCny!==null)finite(source.costCny,'规则整理费用');
    if(source.lane!==undefined&&source.lane!=='prepare')fail('规则整理请求通道不正确。');
    const a=copyAttempt({...source,lane:'prepare'});
    if(a.state==='in_flight'){a.state='uncertain';a.uncertain=true;}
    return a;
  });
}
function ledgerTotals(job){
  const attempts=[...(job.preparationAttempts||[]),...job.tasks.flatMap(t=>t.attempts)];
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
  if(data?.formatVersion!==1||typeof data.id!=='string'||!data.id||data.id.length>200||data.pipelineVersion!==VERSION)fail('备份版本不兼容。');
  validatePack(data.pack);validateSettings(data.settings);
  data.preparationAttempts=validatePreparation(data.preparationAttempts||[]);
  if(data.packHash!==await hashJSON(data.pack)||data.settingsHash!==await hashJSON(data.settings)||data.demo!==data.pack.demo)fail('规则、参数或版本校验失败。');
  for(const key of ['spentCny','heldCny','lastSendAt'])finite(data[key],key);
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
    if(!t.results||Object.keys(t.results).sort().join(',')!=='A,B')fail('双路结果字段不完整。');
    for(const result of Object.values(t.results))if(result!==null)validateResult(result,t.question,t.pages.map(p=>p.page_id));
    if(!Array.isArray(t.reviewHistory)||!Array.isArray(t.attempts))fail('修改或请求记录不完整。');
    for(const r of t.reviewHistory)validateReview(r,t.question);
    if(t.review){validateReview(t.review,t.question);if(!t.reviewHistory.length||canonical(t.review)!==canonical(t.reviewHistory.at(-1)))fail('修改历史不完整。');}
    for(const a of t.attempts){
      if(typeof a.id!=='string'||attemptIds.has(a.id)||!['A','B'].includes(a.lane)||!['in_flight','response_saved','done','error','uncertain'].includes(a.state))fail('请求记录无效。');
      attemptIds.add(a.id);finite(a.reservedCny,'预留费用');if(a.costCny!==null)finite(a.costCny,'请求费用');
      if(a.state==='in_flight'){a.state='uncertain';a.uncertain=true;t.state='uncertain';t.error='上次请求在途时页面关闭，可能已计费；请明确确认后重试。';}
    }
    if(t.review&&!t.inputComplete)fail('缺图任务不能带有人工分数。');
  }
  for(const s of students)for(const q of qs.keys())if(!pairs.has(s+'::'+q))fail('备份漏掉该学生的题目。');
  const totals=ledgerTotals(data);
  if(Math.abs(totals.spentCny-data.spentCny)>1e-6||Math.abs(totals.heldCny-data.heldCny)>1e-6)fail('备份费用与请求账本不一致。');
  // Projection removes unrecognized fields (including accidentally pasted keys).
  return snapshotJob(data);
}

export async function rebindJob(job,files,{load=globalThis.indexedDB?loadJob:async()=>null}={}){
  const latest=await load(job.id);
  if(latest){
    if(latest.id!==job.id||latest.packHash!==job.packHash||latest.settingsHash!==job.settingsHash)fail('重新绑定的已保存任务版本不同。');
    Object.assign(job,latest);
  }
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
      try{validateResult(attempt.response.result,task.question,task.pages.map(p=>p.page_id));if(!task.results[attempt.lane])task.results[attempt.lane]=attempt.response.result;attempt.state='done';task.error='';task.state=task.results.A&&task.results.B?'done':'ready';}
      catch{attempt.state='error';task.state='error';task.error='已保存的响应未通过校验，请按需复核。';}
      changed=true;
    }
  }
  if(changed)await persist(job);
}

export async function runJob(job,{apiKey='',onChange=()=>{},shouldStop=()=>false,fetcher=globalThis.fetch,persist=saveJob,load=loadJob,locks=globalThis.navigator?.locks,clock=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  validatePack(job.pack);validateSettings(job.settings);
  if(job.pipelineVersion!==VERSION||job.packHash!==await hashJSON(job.pack)||job.settingsHash!==await hashJSON(job.settings)||job.demo!==job.pack.demo)fail('考试规则、运行参数或程序版本已改变，请建立新任务。');
  if(!job.demo&&(!apiKey||typeof apiKey!=='string'||/\s/.test(apiKey)))fail('请填写本次使用的 API key。');
  if(!locks?.request)fail('当前浏览器不支持安全的独占任务锁，请使用新版Chrome或Edge。');
  return locks.request('grading-job:'+job.id,{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock)fail('此批次已在另一个页面运行，请勿重复启动。');
    // A second tab may hold stale objects after the first tab finishes. Read the
    // durable record while holding the same lock before deciding what to send.
    const latest=await load(job.id);
    if(latest){
      if(latest.id!==job.id||latest.packHash!==job.packHash||latest.settingsHash!==job.settingsHash||latest.pipelineVersion!==VERSION)fail('已保存任务与当前页面不同，请重新载入。');
      const bound=new Map(job.tasks.flatMap(t=>t.pages.filter(p=>p.file).map(p=>[p.path,p])));
      for(const t of latest.tasks)for(const p of t.pages){const previous=bound.get(p.path);if(previous?.sha256===p.sha256)p.file=previous.file;}
      Object.assign(job,latest);
    }
    await recoverResponses(job,persist);let requests=0;
    const notify=()=>onChange(job);
    for(const task of job.tasks){
      if(shouldStop())break;
      if(!task.inputComplete||task.review||(task.results.A&&task.results.B)||['error','uncertain','input_missing'].includes(task.state))continue;
      if(task.pages.some(p=>!p.file))fail('原图尚未重新绑定，请先选择原来的答题卡文件夹。');
      for(const lane of ['A','B']){
        if(shouldStop())break;if(task.results[lane])continue;
        const interval=job.demo?0:60000/job.settings.requestsPerMinute;
        while(clock()<(job.lastSendAt||0)+interval){if(shouldStop())return {requests,paused:true};await sleep(Math.min(250,(job.lastSendAt||0)+interval-clock()));}
        const reserve=job.demo?0:job.settings.requestReserveCny;
        if(money(job.spentCny+job.heldCny+reserve)>job.settings.budgetCny)fail('预算不足以预留下一次调用，已停止。');
        // Read and verify originals before reserving or making any network call.
        const pages=[];for(const p of task.pages){const ext=p.path.split('.').pop();const file=await readUpload(p.file,'page-'+p.page_id.slice(1)+'.'+ext);if(file.sha256!==p.sha256)fail('原图已改变，已停止：'+p.path);pages.push({...file,page_id:p.page_id});}
        const attempt={id:uuid(),lane,state:'in_flight',reservedCny:reserve,costCny:null,sentAt:new Date(clock()).toISOString(),uncertain:false};
        task.attempts.push(attempt);task.state='running';job.heldCny=money(job.heldCny+reserve);job.lastSendAt=clock();
        await persist(job);notify();requests++;
        let response,status=200;
        try{
          if(job.demo)response=demoResponse(task,lane,attempt.id);
          else{
            const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),240000);
            try{const r=await fetcher('/api/grade',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':apiKey},body:JSON.stringify({pack:job.pack,questionId:task.questionId,pages,lane,requestId:attempt.id}),signal:controller.signal});status=r.status;response=redact(await r.json(),apiKey);}
            finally{clearTimeout(timer);}
          }
        }catch{
          attempt.state='uncertain';attempt.uncertain=true;attempt.error='调用中断，是否已计费不确定。';task.state='uncertain';task.error=attempt.error;
          await persist(job);notify();return {requests,paused:true};
        }
        attempt.response=response;
        const failed=status<200||status>=300||!!response.error;
        settle(job,attempt,response,failed&&response.uncertain===false);
        if(failed){attempt.state=response.uncertain?'uncertain':'error';attempt.uncertain=!!response.uncertain;attempt.error=typeof response.error==='string'?response.error:'接口返回错误。';task.state=attempt.state;task.error=attempt.error;await persist(job);notify();
          if(response.uncertain||status>=500||[401,403,429].includes(status)||['QUOTA','AUTH','MISSING_KEY','SERVER_BUSY'].includes(response.code))return {requests,paused:true};break;
        }
        attempt.state='response_saved';await persist(job);
        try{validateResult(response.result,task.question,task.pages.map(p=>p.page_id));task.results[lane]=response.result;attempt.state='done';task.state=task.results.A&&task.results.B?'done':'ready';task.error='';}
        catch{attempt.state='error';task.state='error';task.error='评分结果未通过完整性检查，分数保留未定。';}
        await persist(job);notify();if(task.state==='error')break;
      }
    }
    return {requests,paused:!!shouldStop()};
  });
}

function csvCell(v){const s=String(v??'');return '"'+((/^[\s]*[=+@-]/.test(s)?"'":'')+s).replaceAll('"','""')+'"';}
export function exportCSV(job){
  const qids=job.pack.questions.map(q=>q.question_id),students=[...new Set(job.tasks.map(t=>t.studentId))].sort(),index=new Map(job.tasks.map(t=>[t.id,t]));
  const rows=[['学号或匿名号',...qids,'建议总分','状态','分数来源','质检提示']];
  for(const student of students){const items=qids.map(q=>advice(index.get(student+'::'+q)));const complete=items.every(a=>a.total!==null);rows.push([student,...items.map(a=>a.total??''),complete?sumScores(items.map(a=>a.total)):'',(job.demo?'合成演示 · ':'')+(complete?'AI建议成绩（非正式）':'未完成（未知分数留空）'),items.map((a,i)=>qids[i]+':'+a.source).join(';'),items.flatMap((a,i)=>a.flags.map(f=>qids[i]+':'+f)).join(';')]);}
  return '\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
function demoResponse(task,lane,id){
  const result={question_id:task.questionId,status:'scored',criteria:task.question.criteria.map(c=>({criterion_id:c.criterion_id,awarded:lane==='B'&&task.questionId==='Q2'&&c===task.question.criteria[0]?0:Math.max(...c.allowed_scores),evidence_refs:task.pages.map(p=>p.page_id),reason:'【离线演示】固定合成结果，不代表实际学生表现。'})),flags:[],alternative_solution:false};
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
