import assert from 'node:assert/strict';
import {access, lstat, readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const forbiddenParts=new Set(['.git','.github','.next','node_modules','api','private','secrets','exports','runs']);
const serverOnlyMarkers=['node:async_hooks','GRADING_SESSION_SECRET','GRADING_ACCESS_CODE'];

async function listFiles(directory,prefix=''){
  const result=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const relative=path.posix.join(prefix,entry.name);
    assert(!entry.isSymbolicLink(),`Export contains a symbolic link: ${relative}`);
    assert(!forbiddenParts.has(entry.name)&&!entry.name.startsWith('.env'),`Private/server path in export: ${relative}`);
    assert(!['server.js','package.json','package-lock.json'].includes(entry.name),`Server build input in export: ${relative}`);
    assert(!/\.(?:ts|tsx|mts|map)$/.test(entry.name),`Source or source map in export: ${relative}`);
    if(entry.isDirectory())result.push(...await listFiles(path.join(directory,entry.name),relative));
    else {assert(entry.isFile(),`Unexpected export entry: ${relative}`);result.push(relative);}
  }
  return result;
}

function staticLinks(html){
  return [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map(match=>match[1]).filter(value=>!value.startsWith('data:'));
}

export async function checkPagesArtifact(output=path.join(root,'out'),basePath=process.env.NEXT_PUBLIC_BASE_PATH??'/exam-grading-assistant'){
  const files=await listFiles(output);
  assert(files.includes('index.html'),'Static homepage is missing.');
  assert(files.includes('.nojekyll'),'The Pages export marker is missing.');
  let bytes=0;
  for(const name of files){
    const filename=path.join(output,name);
    bytes+=(await lstat(filename)).size;
    if(/\.(?:html|js|mjs|json)$/.test(name)&&!name.startsWith('pdfjs/')){
      const contents=await readFile(filename,'utf8');
      for(const marker of serverOnlyMarkers)assert(!contents.includes(marker),`Server-only code reached static export: ${name}`);
    }
  }
  assert(bytes<1024**3,'GitHub Pages export exceeds 1 GiB.');
  const html=await readFile(path.join(output,'index.html'),'utf8');
  const links=staticLinks(html);
  assert(links.some(link=>link.includes('/_next/static/')),'Next.js browser assets are missing.');
  for(const link of links){
    assert(link.startsWith(`${basePath}/`),`Static asset does not use the project base path: ${link}`);
    const name=decodeURIComponent(new URL(link,'https://pages.invalid').pathname.slice(basePath.length+1));
    assert(!name.split('/').includes('..'),'Invalid static asset path.');
    await access(path.join(output,name));
  }
  const {version}=JSON.parse(await readFile(path.join(root,'node_modules/pdfjs-dist/package.json'),'utf8'));
  const pdfRoot=`pdfjs/${version}`;
  for(const item of ['pdf.worker.min.mjs','LICENSE'])await access(path.join(output,pdfRoot,item));
  const pdfSamples=[];
  for(const directory of ['cmaps','standard_fonts','wasm','iccs']){
    const file=files.find(name=>name.startsWith(`${pdfRoot}/${directory}/`));
    assert(file,`Local PDF assets missing: ${directory}`);pdfSamples.push(`${basePath}/${file}`);
  }
  console.log(`Static artifact OK: ${files.length} files, ${(bytes/1024**2).toFixed(1)} MiB; project assets and local PDF resources exist; no server paths or environment files.`);
  return {html,links:[...new Set([...links,`${basePath}/${pdfRoot}/pdf.worker.min.mjs`,...pdfSamples])]};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const basePath=process.env.NEXT_PUBLIC_BASE_PATH??'/exam-grading-assistant';
  const {links}=await checkPagesArtifact(undefined,basePath);
  if(process.argv[2]){
    const base=new URL(process.argv[2]);
    assert(['http:','https:'].includes(base.protocol),'Only HTTP(S) deployment URLs are supported.');
    assert(base.pathname===`${basePath}/`||base.pathname===basePath,'Deployment URL must include the configured project path.');
    for(const resource of [`${basePath}/`,...links]){
      const response=await fetch(new URL(resource,base.origin),{signal:AbortSignal.timeout(15000),redirect:'error'});
      assert.equal(response.status,200,`${resource} returned ${response.status}`);
      const body=await response.arrayBuffer();
      assert(body.byteLength>0,`Empty resource: ${resource}`);
      if(resource.includes('/_next/')||resource.includes('/pdfjs/'))assert(!response.headers.get('content-type')?.includes('text/html'),`Asset returned an HTML fallback: ${resource}`);
    }
    console.log('Live static deployment OK: homepage, browser assets and local PDF resources. No model requests were sent.');
  }
}
