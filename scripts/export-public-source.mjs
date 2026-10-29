/** Rebuild a GitHub publication from committed website source only. */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:16*1024*1024});
const revision=git('rev-parse','HEAD').toString().trim();
const entries=git('ls-tree','-r','-z',revision).toString().split('\0').filter(Boolean);
const output=path.join(root,'outputs','github-source');
if(existsSync(output))throw Error('Export already exists. Review and remove only the generated outputs/github-source directory before re-exporting.');
const tree=[];
for(const entry of entries){
  const [header,name]=entry.split('\t');const [mode,type]=header.split(' ');
  if(type!=='blob'||!['100644','100755'].includes(mode))throw Error('Unsupported source entry: '+name);
  if(name.startsWith('/')||name.split('/').includes('..')||/(^|\/)(private|secrets|runs|logs|exports|data|output|outputs|work|tmp|node_modules|dist|\.next|\.vinext|\.wrangler|\.sites-runtime|\.agents|\.codex|\.git)(\/|$)/.test(name)||/(^|\/)(\.env|\.dev\.vars)($|\.)/.test(name))throw Error('Excluded source path: '+name);
  let content=git('show',revision+':'+name).toString('utf8');
  if(content.includes('\u0000')||content.includes('\ufffd'))throw Error('Non-text source requires review: '+name);
  if(name==='.openai/hosting.json')content=JSON.stringify({d1:null,r2:null},null,2)+'\n';
  if(/appgprj_[a-f0-9]{16,}/.test(content)||/\/Users\/[^\s"']+/.test(content))throw Error('Private deployment or machine path in '+name);
  const dest=path.join(output,name);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,content,{mode:mode==='100755'?0o755:0o644});
  tree.push({path:name,mode,type:'blob',content});
}
mkdirSync(path.join(root,'outputs'),{recursive:true});
writeFileSync(path.join(root,'outputs','github-tree.json'),JSON.stringify(tree));
writeFileSync(path.join(root,'outputs','github-source-manifest.json'),JSON.stringify({sourceCommit:revision,files:tree.map(f=>({path:f.path,sha256:createHash('sha256').update(f.content).digest('hex')}))},null,2)+'\n');
console.log(JSON.stringify({sourceCommit:revision,files:tree.length,bytes:tree.reduce((n,f)=>n+Buffer.byteLength(f.content),0),directory:output}));
