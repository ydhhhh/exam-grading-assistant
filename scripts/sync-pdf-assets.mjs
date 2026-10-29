import {cp, mkdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Serve worker, fonts, CMaps and decoders from this site, never a public CDN.
const root=fileURLToPath(new URL('../',import.meta.url));
export async function syncPDFAssets(){
  const source=path.join(root,'node_modules/pdfjs-dist');
  const {version}=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
  const target=path.join(root,'public/pdfjs',version);
  await mkdir(target,{recursive:true});
  for(const name of ['cmaps','standard_fonts','wasm','iccs','LICENSE'])await cp(path.join(source,name),path.join(target,name),{recursive:true});
  await cp(path.join(source,'legacy/build/pdf.worker.min.mjs'),path.join(target,'pdf.worker.min.mjs'));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await syncPDFAssets();
