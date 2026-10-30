/** Pure HTTP helpers shared by server routes and the in-memory browser adapter. */
/** Behind a reverse proxy, configure the public origin explicitly. Never trust
 * X-Forwarded-* from the client: a proxy must not turn those into authorization. */
export function normalizePublicOrigin(value){
  if(value===undefined||value==='')return null;
  if(typeof value!=='string'||value!==value.trim())throw new Error('Invalid public origin');
  let url;try{url=new URL(value);}catch{throw new Error('Invalid public origin');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin==='null')throw new Error('Invalid public origin');
  return url.origin;
}
export function requestOrigin(request,runtime={}){
  if(runtime.originInvalid)return null;
  if(runtime.publicOrigin)return runtime.publicOrigin;
  let url;try{url=new URL(request.url);}catch{return null;}
  if(!['http:','https:'].includes(url.protocol))return null;
  const host=request.headers.get('host')||url.host;
  // Host is supplied by the HTTP server, unlike Request.url which Next may
  // normalize to localhost. For HTTPS termination the explicit origin above is
  // required, so an untrusted forwarded protocol never enables a secure cookie.
  if(!/^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::[0-9]{1,5})?$/.test(host))return null;
  try{return new URL(url.protocol+'//'+host).origin;}catch{return null;}
}
export function isSameOriginRequest(request,runtime={}){
  const expected=requestOrigin(request,runtime);
  return expected!==null&&request.headers.get('origin')===expected;
}
export function runtimeResponse(body,status=200,extraHeaders={}){
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store, max-age=0','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...extraHeaders}});
}
export const runtimeFailure=(code,error,status=401,metadata={})=>runtimeResponse({...metadata,code,error,uncertain:false,estimatedCny:0,notSent:true},status);

export function redact(value,key){let s=String(value);if(key)s=s.split(key).join('[REDACTED]');return s.replace(/sk-[A-Za-z0-9_-]{8,}/g,'[REDACTED]');}
export function jsonResponse(body,status=200,key=''){
  return new Response(redact(JSON.stringify(body),key),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store, max-age=0','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
}
