/** Personal-key transport for static hosting. No local API server or shared secrets. */
import {handleAPI} from './api-core.mjs';
import {PROVIDERS} from './providers.mjs';
import {normalizePublicOrigin,runtimeFailure} from './runtime-http.mjs';

const endpoints=new Set(Object.values(PROVIDERS).map(provider=>provider.endpoint));
const actions=/^\/api\/(prepare|identity|grade|review)$/;

/** Dependency injection is only for synthetic tests; production uses browser fetch. */
export function createBrowserAPIFetch({origin,upstreamFetch,credentialMode='test'}={}){
  return async function browserFetch(path,options={}){
    // A static site has no trusted place for a shared service credential/session.
    // Missing stage keys fail in the same core validation used by the server.
    if(credentialMode!=='test'||options.credentialMode&&options.credentialMode!=='test')return runtimeFailure('PAGES_PERSONAL_KEY','GitHub Pages 仅支持本人填写阶段密钥；负责人统一配置的批次请在服务器版继续。',400);
    const match=typeof path==='string'&&actions.exec(path);
    if(!match)return runtimeFailure('NOT_FOUND','静态网页不支持此接口。',404);
    let request,publicOrigin;
    try{
      publicOrigin=normalizePublicOrigin(origin??globalThis.location?.origin);
      if(!publicOrigin)throw new Error('Missing browser origin');
      const supplied=new Headers(options.headers);
      if(supplied.has('cookie'))return runtimeFailure('PAGES_PERSONAL_KEY','静态网页不能使用服务器登录会话，请填写本人阶段密钥。',400);
      const headers=new Headers({origin:publicOrigin});
      for(const name of ['content-type','x-api-key','x-api-provider'])if(supplied.has(name))headers.set(name,supplied.get(name));
      const buffered=new Request(publicOrigin+path,{method:options.method||'GET',headers,body:options.body,signal:options.signal});
      // Browser Request guards remove a manually supplied Origin. The core is
      // invoked in memory, so retain our own Headers instead of weakening its
      // shared same-origin check. This envelope is never passed to fetch.
      request={url:buffered.url,method:buffered.method,headers,body:buffered.body,signal:buffered.signal};
    }catch{return runtimeFailure('BROWSER_REQUEST','无法创建本地评分请求；请从已部署的网页重新提交。',400);}
    const fetcher=upstreamFetch??globalThis.fetch;
    if(typeof fetcher!=='function')return runtimeFailure('BROWSER_FETCH','当前浏览器不能发出模型请求。',503);
    const officialFetch=(url,init)=>{
      // Only the fixed official endpoint receives the current stage key. Never
      // forward browser cookies, local request headers or a redirect target.
      if(!endpoints.has(url))throw new Error('Unsupported official endpoint');
      const headers=new Headers(init.headers);
      return fetcher(url,{
        method:'POST',mode:'cors',credentials:'omit',redirect:'manual',
        cache:'no-store',referrerPolicy:'no-referrer',
        headers:{authorization:headers.get('authorization'),'content-type':'application/json'},
        body:init.body,signal:init.signal,
      });
    };
    // requestId remains in the local ledger and validated response. Kimi CORS
    // rejects X-Client-Request-Id, so direct requests use only these two headers.
    return handleAPI(request,match[1],officialFetch,{mode:'test',ready:true,publicOrigin});
  };
}

export const browserAPIFetch=createBrowserAPIFetch();
