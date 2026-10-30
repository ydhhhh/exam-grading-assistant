import test from 'node:test';
import assert from 'node:assert/strict';

// This test file runs in its own Node test process, with the actual public build flags.
process.env.NEXT_PUBLIC_DEPLOYMENT_TARGET='github-pages';
process.env.NEXT_PUBLIC_BASE_PATH='/exam-grading-assistant';
const {IS_GITHUB_PAGES,publicPath,storageName,createDeploymentFetch,deploymentFetch}=await import('../lib/grading/browser-deployment.mjs');
const {DEFAULT_STAGE_PROFILES}=await import('../lib/grading/providers.mjs');
const {createStudentPDFJob,prepareTeachingMaterials,runJob,snapshotJob,importBackup,exportCSV,loadJob,demoJob,rebindJob,resolveStudentIdentity,reviewTask,taskAdvice}=await import('../lib/grading/browser-workflow.mjs');
const {renderPDFToImages}=await import('../lib/grading/pdf-images.mjs');
const {fixturePack,fixtureResult,fixtureIdentity,syntheticPDF,renderPDF,envelope}=await import('./helpers/pdf-rendering.mjs');
const locks={request:async(_name,_options,fn)=>fn({})};
const keys={prepare:'synthetic-prepare-only',grade:'synthetic-grade-only',review:'synthetic-review-only'};
const runOptions={stageKeys:keys,renderPDF,locks,persist:async()=>{},load:async()=>null,isOnline:()=>true};
async function sample(settings={}){
  const file=new File([await syntheticPDF(2)],'900000001.pdf',{type:'application/pdf'});
  return createStudentPDFJob(fixturePack(),[file],settings);
}

test('Pages initializes defaults and rejects sessions locally without any API network request',async()=>{
  assert.equal(IS_GITHUB_PAGES,true);
  const request=createDeploymentFetch({fetcher:()=>assert.fail('Pages has no local server'),loadBrowserAPI:()=>assert.fail('runtime config does not load grading API')});
  const response=await request('/api/runtime-config');assert.equal(response.status,200);
  const config=await response.json();
  assert.equal(config.mode,'test');assert.equal(config.ready,true);assert.equal(config.authenticated,false);assert.equal(config.browserDirect,true);
  assert.deepEqual(config.stageProfiles,DEFAULT_STAGE_PROFILES);assert.deepEqual(config.reviewProfile,DEFAULT_STAGE_PROFILES.review);
  config.stageProfiles.prepare.model='mutated-in-test';
  assert.deepEqual((await (await request('/api/runtime-config')).json()).stageProfiles,DEFAULT_STAGE_PROFILES);
  for(const method of ['POST','DELETE'])assert.equal((await request('/api/session',{method})).status,404);
});

test('server deployment retains its existing same-origin request transport',async()=>{
  const options={method:'POST',credentials:'same-origin',headers:{'X-Api-Key':'synthetic-node-key'},body:'{}'};
  let called=0;
  const request=createDeploymentFetch({target:'node',fetcher:async(path,received)=>{called++;assert.equal(path,'/api/prepare');assert.equal(received,options);return new Response('{}');},loadBrowserAPI:()=>assert.fail('server mode must not use browser adapter')});
  assert.equal((await request('/api/prepare',options)).status,200);assert.equal(called,1);
});

test('Project Pages homepage and every PDF auxiliary asset stay under the public base path',async()=>{
  assert.equal(publicPath('/'),'/exam-grading-assistant/');
  assert.equal(publicPath('/pdfjs/6/pdf.worker.min.mjs'),'/exam-grading-assistant/pdfjs/6/pdf.worker.min.mjs');
  assert.equal(publicPath('/pdfjs/6/',''),'/pdfjs/6/');
  assert.throws(()=>publicPath('//external.example/a'),/本站资源/);
  assert.throws(()=>publicPath('/pdfjs/6/','https://external.example'),/部署路径/);
  let captured;
  const engine={version:'synthetic-version',getDocument:options=>{captured=options;return {promise:Promise.reject(Error('synthetic stop after asset capture')),destroy:async()=>{}};}};
  await assert.rejects(()=>renderPDFToImages(new Uint8Array([1]),{pdfjs:engine}),/synthetic stop/);
  for(const [key,folder] of Object.entries({cMapUrl:'cmaps',iccUrl:'iccs',standardFontDataUrl:'standard_fonts',wasmUrl:'wasm'}))assert.equal(captured[key],`/exam-grading-assistant/pdfjs/synthetic-version/${folder}/`);
});

test('Pages progress, preparation drafts and locks have a namespace separate from Node and other project paths',async t=>{
  for(const name of ['grading-assistant-domestic','grading-domestic-preparation-v1','grading-runner','grading-job:']){
    assert.notEqual(storageName(name),storageName(name,'node'));
    assert.notEqual(storageName(name),storageName(name,'github-pages','/another-project'));
    assert.equal(storageName(name,'node'),name);
  }
  const original=globalThis.indexedDB;let opened;
  const emptyStore={get(){const read={};queueMicrotask(()=>{read.result=undefined;read.onsuccess();});return read;}};
  globalThis.indexedDB={open(name){
    opened=name;const request={};
    queueMicrotask(()=>{request.result={close(){},transaction(){return {objectStore(){return emptyStore;}};}};request.onsuccess();});
    return request;
  }};
  t.after(()=>{if(original===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=original;});
  assert.equal(await loadJob(),null);assert.equal(opened,storageName('grading-assistant-domestic'));
});

test('managed backups stay readable and exportable but cannot issue paid requests or change credential mode in Pages',async()=>{
  const job=await sample({credentialMode:'managed'}),backup=snapshotJob(job);
  const restored=await importBackup(backup);assert.equal(restored.settings.credentialMode,'managed');
  assert.ok(exportCSV(restored).length>0);
  await assert.rejects(()=>runJob(restored,{...runOptions,persist:()=>assert.fail('must reject before state changes'),fetcher:()=>assert.fail('managed backup cannot reach network')}),/个人密钥模式的新批次/);
  assert.deepEqual(snapshotJob(restored),backup);
  await rebindJob(restored,job.documents.map(document=>document.file),{load:async()=>null});
  resolveStudentIdentity(restored,restored.documents[0].id,{studentId:'900000001',name:'合成测试甲'});
  reviewTask(restored.tasks[0],{C1:4},'Synthetic teacher','Manual review of synthetic page');
  assert.equal(taskAdvice(restored,restored.tasks[0]).total,4);
  const reviewed=await importBackup(snapshotJob(restored));
  assert.equal(reviewed.settings.credentialMode,'managed');assert.equal(reviewed.tasks[0].review.scores.C1,4);
  assert.ok(exportCSV(reviewed).includes('合成测试甲'));
  assert.ok(exportCSV(reviewed).includes('\"4\",\"4\"'));assert.ok(exportCSV(reviewed).includes('Q1:human'));
  await assert.rejects(()=>runJob(restored,runOptions),/个人密钥模式的新批次/);
  assert.equal(restored.tasks[0].attempts.length,0);assert.equal(restored.spentCny,0);
  const demo=await demoJob();
  const outcome=await runJob(demo,{...runOptions,fetcher:()=>assert.fail('demo must remain offline')});
  assert.ok(outcome.requests>0);
});

test('default Pages workflow sends prepare, identity, initial grade and independent review directly to official APIs with isolated keys',async t=>{
  const location=globalThis.location;
  globalThis.location={origin:'https://synthetic-grading.github.io'};
  t.after(()=>{if(location===undefined)delete globalThis.location;else globalThis.location=location;});
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const body=JSON.parse(options.body),schema=body.text?.format?.name||body.response_format?.json_schema?.name;
    const stage=schema==='course_pack'?'prepare':body.model==='kimi-k3.1-pro'?'review':'grade';
    calls.push({url,stage,schema,body});
    assert.equal(options.credentials,'omit');assert.equal(options.mode,'cors');
    assert.equal(options.headers.authorization,'Bearer '+keys[stage]);
    assert.deepEqual(Object.keys(options.headers).sort(),['authorization','content-type']);
    assert.equal(url,stage==='grade'?'https://api.deepseek.com/responses':'https://api.moonshot.cn/v1/chat/completions');
    const draft={...fixturePack(),approved_by:''};
    const result=schema==='course_pack'?{pack:draft,warnings:[]}:schema==='student_identity'?fixtureIdentity():fixtureResult();
    const response=stage==='grade'?envelope(result):{id:'synthetic-chat-response',model:body.model,usage:{prompt_tokens:1000,completion_tokens:200},choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)}}]};
    return Response.json(response);
  });
  const material=new File(['Synthetic teacher rules'],'rules.txt',{type:'text/plain'});
  const prepared=await prepareTeachingMaterials({paper:material,solution:material,rubric:material},'kimi');
  const response=await deploymentFetch('/api/prepare',{method:'POST',credentialMode:'test',headers:{'Content-Type':'application/json','X-Api-Key':keys.prepare,'X-Api-Provider':'kimi'},body:JSON.stringify({documents:prepared.documents,requestId:'synthetic-pages-prepare',stageProfiles:DEFAULT_STAGE_PROFILES})});
  assert.equal(response.status,200);assert.equal((await response.json()).ready,true);
  const job=await sample();
  const outcome=await runJob(job,runOptions);
  assert.equal(outcome.requests,3);assert.equal(job.tasks[0].state,'done');assert.equal(job.tasks[0].modelReviewState,'done');
  assert.deepEqual(calls.map(call=>call.stage),['prepare','grade','grade','review']);
  assert.deepEqual(calls.map(call=>call.schema),['course_pack','student_identity','grading_result','grading_result']);
  const reviewText=JSON.stringify(calls.at(-1).body);
  assert.ok(!reviewText.includes('Synthetic page evidence'),'independent review must not receive the initial explanation');
  assert.ok(!reviewText.includes('initialResult'));
  const snapshot=snapshotJob(job);
  for(const key of Object.values(keys))assert.ok(!JSON.stringify(snapshot).includes(key));
  const restored=await importBackup(snapshot);assert.equal(restored.tasks[0].modelReviewState,'done');
  assert.ok(job.spentCny>0);assert.equal(job.heldCny,0);
});
