import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedInputError,readBoundedInput} from '../lib/grading/bounded-input.mjs';
import {handleAPI} from '../lib/grading/api-service.mjs';
import {handleSession,resolveRuntime} from '../lib/grading/server-runtime.mjs';

const encoder=new TextEncoder();
const input=(stream,signal)=>({body:stream,signal});
function request(stream,controller=new AbortController()){
  return new Request('https://grading.example/api/grade',{method:'POST',headers:{origin:'https://grading.example','content-type':'application/json','x-api-key':'synthetic-stream-test-key'},body:stream,duplex:'half',signal:controller.signal});
}

test('bounded incoming reader accepts split UTF-8 at exact byte limit and releases its reader',async()=>{
  const bytes=encoder.encode('中文'),stream=new ReadableStream({start(c){c.enqueue(bytes.slice(0,1));c.enqueue(bytes.slice(1));c.close();}});
  assert.equal(await readBoundedInput(input(stream),{maximum:bytes.length}),'中文');
  assert.equal(stream.locked,false);
});

test('incoming byte cap does not wait for a stalled cancellation callback',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(encoder.encode('oversized'));},cancel(){cancelled=true;return new Promise(()=>{});}});
  await assert.rejects(readBoundedInput(input(stream),{maximum:3,timeoutMs:100}),e=>e instanceof BoundedInputError&&e.code==='TOO_LARGE'&&e.status===413);
  assert.equal(cancelled,true);assert.equal(stream.locked,false);
});

test('incoming total deadline rejects a stalled stream and releases resources',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(encoder.encode('{'));},cancel(){cancelled=true;return new Promise(()=>{});}});
  await assert.rejects(readBoundedInput(input(stream),{maximum:100,timeoutMs:15}),e=>e.code==='REQUEST_TIMEOUT'&&e.status===408);
  assert.equal(cancelled,true);assert.equal(stream.locked,false);
});

test('request abort interrupts body reading and malformed UTF-8 is never replaced silently',async()=>{
  const controller=new AbortController(),stream=new ReadableStream({pull(){}});
  const pending=readBoundedInput(input(stream,controller.signal),{maximum:100});controller.abort();
  await assert.rejects(pending,e=>e.code==='REQUEST_ABORTED');assert.equal(stream.locked,false);
  const malformed=new ReadableStream({start(c){c.enqueue(new Uint8Array([0xc3,0x28]));c.close();}});
  await assert.rejects(readBoundedInput(input(malformed),{maximum:10}),e=>e.code==='INVALID_ENCODING');
});

test('four interrupted incoming API bodies release all request slots with no provider call',async()=>{
  let calls=0;const fetcher=async()=>{calls++;throw Error('must not reach provider');};
  const controllers=Array.from({length:4},()=>new AbortController());
  const pending=controllers.map(controller=>handleAPI(request(new ReadableStream({pull(){}}),controller),'grade',fetcher));
  const crowded=await handleAPI(request('{}'),'grade',fetcher);assert.equal(crowded.status,429);assert.equal((await crowded.json()).code,'SERVER_BUSY');
  controllers.forEach(controller=>controller.abort());
  for(const response of await Promise.all(pending)){
    const data=await response.json();assert.equal(data.code,'REQUEST_ABORTED');assert.equal(data.notSent,true);assert.equal(data.estimatedCny,0);assert.equal(data.uncertain,false);
  }
  const available=await handleAPI(request('{}'),'grade',fetcher);assert.equal((await available.json()).code,'STAGE_PROFILES');assert.equal(calls,0);
});

test('aborting a stalled login returns a bounded no-charge error without a session',async()=>{
  const runtime=resolveRuntime({GRADING_MODE:'managed',GRADING_API_KEY:'synthetic-primary-key-for-stream-test',GRADING_PREPARE_API_KEY:'synthetic-prepare-key-for-stream-test',GRADING_REVIEW_API_KEY:'synthetic-review-key-for-stream-test',GRADING_ACCESS_CODE:'synthetic-access-code',GRADING_SESSION_SECRET:'synthetic-session-secret-at-least-thirty-two'});
  const controller=new AbortController();
  const pending=handleSession(request(new ReadableStream({pull(){}}),controller),runtime);controller.abort();
  const response=await pending,data=await response.json();assert.equal(data.code,'REQUEST_ABORTED');assert.equal(data.notSent,true);assert.equal(data.estimatedCny,0);assert.equal(response.headers.get('set-cookie'),null);
});
