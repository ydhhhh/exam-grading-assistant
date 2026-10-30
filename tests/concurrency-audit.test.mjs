import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {renderPDF} from './helpers/pdf-rendering.mjs';
import {createStudentPDFJob as createDefaultStudentPDFJob, resolveStudentIdentity, runJob, snapshotJob, importBackup, rebindJob} from '../lib/grading/browser-workflow.mjs';

import {DEFAULT_STAGE_PROFILES} from '../lib/grading/providers.mjs';
const createStudentPDFJob=(p,f,s={},r)=>createDefaultStudentPDFJob(p,f,{reviewProfile:null,...s},r);
// Independent scheduler audit: synthetic pages and controllable network/storage only.
const locks={request:async(_name,_options,fn)=>fn({name:'audit-lock'})};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function until(predicate){const deadline=Date.now()+5000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}throw Error('Audit condition was not reached within 5 seconds');}
function result(questionId){return {question_id:questionId,status:'scored',criteria:[{criterion_id:'C1',awarded:1,evidence_refs:['P1'],reason:'Synthetic evidence'}],flags:[],alternative_solution:false};}
function response(questionId,cost=.125){return new Response(JSON.stringify({provider:'deepseek',stageProfile:DEFAULT_STAGE_PROFILES.grade,result:result(questionId),usage:{input_tokens:10,output_tokens:10},estimatedCny:cost,model:'mock',raw:'synthetic result'}),{status:200,headers:{'content-type':'application/json'}});}
async function readyJob(count=8,settings={}){
 const pack={exam_id:'AUDIT',title:'Synthetic scheduler audit',version:'1',demo:false,approved_by:'Synthetic reviewer',policies:'Synthetic data only.',questions:Array.from({length:count},(_,i)=>({question_id:'Q'+(i+1),text:'Synthetic question',solution:'Synthetic solution',max_score:1,criteria:[{criterion_id:'C1',description:'Synthetic criterion',allowed_scores:[0,1],requires:[]}]}))};
 const pdf=await PDFDocument.create();for(let i=0;i<=count;i++)pdf.addPage([200,300]);
 const file=new File([await pdf.save()],'9000000099.pdf',{type:'application/pdf'});
 const job=await createStudentPDFJob(pack,[file],settings);resolveStudentIdentity(job,job.documents[0].id,{studentId:'9000000099',name:'Synthetic'});return {job,file};
}
function opts(fetcher,extra={}){return {renderPDF,apiKey:'audit-key-never-persist',locks,fetcher,persist:async()=>{},load:async()=>null,isOnline:()=>true,...extra};}
function gatedFetcher(){const calls=[];let active=0,peak=0;return {calls,get active(){return active;},get peak(){return peak;},fetcher:async(url,options)=>{assert.equal(url,'/api/grade');const body=JSON.parse(options.body);const gate=deferred();calls.push({body,...gate});active++;peak=Math.max(peak,active);try{return await gate.promise;}finally{active--;}}};}

test('audit: four requests stay bounded and reversed completion writes never overlap or erase prior results',{timeout:10000},async()=>{
 const {job}=await readyJob(6);const network=gatedFetcher();let durable=null,writes=0,peakWrites=0;const states=[];
 const persist=async current=>{writes++;peakWrites=Math.max(peakWrites,writes);const captured=snapshotJob(current);await tick();durable=captured;states.push(captured);writes--;};
 const fetcher=async(url,options)=>{const body=JSON.parse(options.body);assert.ok(durable.tasks.some(t=>t.attempts.some(a=>a.id===body.requestId&&a.state==='in_flight')),'request must be durably registered before sending');return network.fetcher(url,options);};
 const running=runJob(job,opts(fetcher,{persist}));
 await until(()=>network.calls.length===4);assert.equal(network.active,4);
 network.calls[2].resolve(response(network.calls[2].body.questionId));await until(()=>network.calls.length===5);
 network.calls[0].resolve(response(network.calls[0].body.questionId));await until(()=>network.calls.length===6);
 for(const i of [5,4,3,1])network.calls[i].resolve(response(network.calls[i].body.questionId));
 const out=await running;assert.equal(out.requests,6);assert.equal(network.peak,4);assert.equal(peakWrites,1);assert.equal(new Set(network.calls.map(c=>c.body.questionId)).size,6);
 assert.ok(durable.tasks.every(t=>t.result&&t.state==='done'));assert.equal(durable.spentCny,.75);assert.equal(durable.heldCny,0);
 let completed=0;for(const state of states){const n=state.tasks.filter(t=>t.result).length;assert.ok(n>=completed);completed=n;assert.ok(state.spentCny+state.heldCny<=state.settings.budgetCny);}
 await importBackup(durable);
});

test('audit: temporary budget holds reduce concurrency but do not strand the rest of the batch',{timeout:10000},async()=>{
 const {job}=await readyJob(8,{budgetCny:10,requestReserveCny:5,concurrency:4});let active=0,peak=0,calls=0;
 const fetcher=async(_,options)=>{calls++;active++;peak=Math.max(peak,active);await tick();await tick();active--;return response(JSON.parse(options.body).questionId,.25);};
 const out=await runJob(job,opts(fetcher));assert.equal(out.requests,8);assert.equal(calls,8);assert.ok(peak<=2);assert.ok(job.tasks.every(t=>t.result));assert.equal(job.spentCny,2);assert.equal(job.heldCny,0);
});

test('audit: network uncertainty halts refill, drains the other calls, and never automatically repeats the uncertain task',{timeout:10000},async()=>{
 const {job,file}=await readyJob(8);const network=gatedFetcher();let durable;
 const running=runJob(job,opts(network.fetcher,{persist:async j=>{durable=snapshotJob(j);}}));
 await until(()=>network.calls.length===4);network.calls[0].reject(Error('network lost'));
 await until(()=>job.tasks[0].state==='uncertain');for(const c of network.calls.slice(1))c.resolve(response(c.body.questionId));
 const out=await running;assert.equal(out.paused,true);assert.equal(network.calls.length,4);assert.equal(network.active,0);assert.equal(job.tasks.filter(t=>t.result).length,3);assert.equal(job.heldCny,5);
 const restored=await importBackup(durable);await rebindJob(restored,[file],{load:async()=>null});const resumed=[];
 await runJob(restored,opts(async(_,options)=>{const body=JSON.parse(options.body);resumed.push(body.questionId);return response(body.questionId);}));
 assert.ok(!resumed.includes(network.calls[0].body.questionId));assert.equal(resumed.length,4);assert.equal(restored.heldCny,5);assert.equal(restored.tasks.filter(t=>t.result).length,7);
});

test('audit: a failed response save stops refill but already returned responses remain recoverable',{timeout:10000},async()=>{
 const {job,file}=await readyJob(8);const network=gatedFetcher();let durable,failed=false;
 const persist=async j=>{if(!failed&&j.tasks.some(t=>t.attempts.some(a=>a.state==='response_saved'))){failed=true;throw Error('synthetic storage failure');}await tick();durable=snapshotJob(j);};
 const running=runJob(job,opts(network.fetcher,{persist}));const rejected=assert.rejects(running,/storage/);
 await until(()=>network.calls.length===4);network.calls[0].resolve(response(network.calls[0].body.questionId));await until(()=>failed);
 for(const c of network.calls.slice(1))c.resolve(response(c.body.questionId));await rejected;
 assert.equal(network.calls.length,4);assert.equal(network.active,0);assert.ok(durable.tasks.slice(0,4).every(t=>t.result||t.attempts.some(a=>a.response?.result)));
 const restored=await importBackup(durable);await rebindJob(restored,[file],{load:async()=>null});const resumed=[];
 await runJob(restored,opts(async(_,options)=>{const body=JSON.parse(options.body);resumed.push(body.questionId);return response(body.questionId);}));
 assert.equal(resumed.length,4);assert.ok(network.calls.every(c=>!resumed.includes(c.body.questionId)));assert.ok(restored.tasks.every(t=>t.result));
});

test('audit: pause during page reading prevents reservation and send',{timeout:10000},async()=>{
 const {job}=await readyJob(6);const reading=deferred();let entered=0,stopped=false,calls=0;
 for(const task of job.tasks){const original=task.pages[0].file;task.pages[0].file={name:original.name,type:original.type,size:original.size,arrayBuffer:async()=>{entered++;await reading.promise;return original.arrayBuffer();}};}
 const running=runJob(job,opts(async()=>{calls++;throw Error('must not send');},{shouldStop:()=>stopped}));
 await until(()=>entered>0);stopped=true;reading.resolve();await running;assert.equal(calls,0);assert.equal(job.heldCny,0);assert.ok(job.tasks.every(t=>t.attempts.length===0));
});

test('audit: offline state drains successful in-flight responses and leaves remaining tasks untouched',{timeout:10000},async()=>{
 const {job}=await readyJob(8);const network=gatedFetcher();let online=true;
 const running=runJob(job,opts(network.fetcher,{isOnline:()=>online}));await until(()=>network.calls.length===4);online=false;
 for(const c of network.calls)c.resolve(response(c.body.questionId));const out=await running;
 assert.equal(out.paused,true);assert.equal(network.calls.length,4);assert.equal(job.tasks.filter(t=>t.result).length,4);assert.equal(job.heldCny,0);assert.ok(job.tasks.slice(4).every(t=>t.attempts.length===0));
});


test('audit: pausing while a reservation is being saved cancels the unsent fee reservation',{timeout:10000},async()=>{
 const {job}=await readyJob(4);const saving=deferred();let entered=false,stopped=false,calls=0,durable;
 const persist=async j=>{if(!entered&&j.tasks.some(t=>t.state==='running')){entered=true;await saving.promise;}durable=snapshotJob(j);};
 const running=runJob(job,opts(async()=>{calls++;throw Error('must not send');},{persist,shouldStop:()=>stopped}));
 await until(()=>entered);stopped=true;saving.resolve();const out=await running;
 assert.equal(out.paused,true);assert.equal(calls,0);assert.equal(job.heldCny,0);assert.equal(job.tasks[0].state,'ready');assert.equal(job.tasks[0].attempts[0].costCny,0);await importBackup(durable);
});

test('audit: browser runner lock remains held until all outstanding calls have settled',{timeout:10000},async()=>{
 const held=new Set();const realLocks={request:async(name,_options,fn)=>{if(held.has(name))return fn(null);held.add(name);try{return await fn({name});}finally{held.delete(name);}}};
 const first=await readyJob(6),second=await readyJob(2);const network=gatedFetcher();
 const running=runJob(first.job,opts(network.fetcher,{locks:realLocks}));await until(()=>network.calls.length===4);
 network.calls[0].reject(Error('lost connection'));await until(()=>first.job.tasks[0].state==='uncertain');let extraCalls=0;
 await assert.rejects(()=>runJob(second.job,opts(async()=>{extraCalls++;},{locks:realLocks})),/另一个页面/);assert.equal(extraCalls,0);
 for(const c of network.calls.slice(1))c.resolve(response(c.body.questionId));await running;assert.equal(held.size,0);
 await runJob(second.job,opts(async(_,options)=>{extraCalls++;return response(JSON.parse(options.body).questionId);},{locks:realLocks}));assert.equal(extraCalls,2);
});

test('audit: identity calls use the same four-slot limit and all identities finish before any grading',{timeout:10000},async()=>{
 const seed=await readyJob(1);const bytes=await seed.file.arrayBuffer();const ids=['9000000101','9000000102','9000000103','9000000104','9000000105'];
 const job=await createStudentPDFJob(seed.job.pack,ids.map(id=>new File([bytes],id+'.pdf',{type:'application/pdf'})));
 const covers=[];let gradeCalls=0,allIdentitiesSettled=false;
 const fetcher=async(url,options)=>{const body=JSON.parse(options.body);if(url==='/api/grade'){assert.equal(allIdentitiesSettled,true);gradeCalls++;return response(body.questionId);}
  assert.equal(url,'/api/identity');const gate=deferred();covers.push({...gate,requestId:body.requestId});return gate.promise;};
 const identityResponse=(i)=>new Response(JSON.stringify({provider:'deepseek',stageProfile:DEFAULT_STAGE_PROFILES.grade,identity:{name:'Synthetic '+i,student_id:ids[i],name_status:'readable',student_id_status:'readable',warnings:[]},usage:{input_tokens:1,output_tokens:1},estimatedCny:.01}),{status:200});
 const running=runJob(job,opts(fetcher));await until(()=>covers.length===4);assert.equal(gradeCalls,0);
 covers[2].resolve(identityResponse(2));await until(()=>covers.length===5);assert.equal(gradeCalls,0);
 for(const i of [4,3,1])covers[i].resolve(identityResponse(i));await tick();assert.equal(gradeCalls,0);
 allIdentitiesSettled=true;covers[0].resolve(identityResponse(0));const out=await running;assert.equal(out.requests,10);assert.equal(gradeCalls,5);assert.ok(job.tasks.every(t=>t.result));
});
