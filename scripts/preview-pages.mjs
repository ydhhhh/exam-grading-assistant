import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const output=fileURLToPath(new URL('../out/',import.meta.url));
const basePath=process.env.NEXT_PUBLIC_BASE_PATH??'/exam-grading-assistant';
const port=Number(process.env.PORT||3037);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.wasm':'application/wasm','.txt':'text/plain; charset=utf-8','.woff2':'font/woff2','.ttf':'font/ttf'};
createServer(async(request,response)=>{
  try{
    if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
    const pathname=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname);
    if(pathname===basePath){response.writeHead(308,{Location:`${basePath}/`});response.end();return;}
    if(!pathname.startsWith(`${basePath}/`)){response.writeHead(404);response.end('Not found');return;}
    const relative=pathname.slice(basePath.length+1);
    const filename=path.resolve(output,relative);
    if(filename!==output.slice(0,-1)&&!filename.startsWith(output)){response.writeHead(404);response.end();return;}
    const resolved=(await stat(filename)).isDirectory()?path.join(filename,'index.html'):filename;
    const body=await readFile(resolved);
    response.writeHead(200,{'Content-Type':mime[path.extname(resolved)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    response.end(request.method==='HEAD'?undefined:body);
  }catch{response.writeHead(404);response.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Static preview: http://127.0.0.1:${port}${basePath}/`));
