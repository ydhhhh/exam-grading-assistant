import {access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const standalone=path.join(root,'.next/standalone');
try { await access(path.join(standalone,'server.js')); }
catch { console.error('请先运行 npm ci 和 npm run build。'); process.exit(1); }
const child=spawn(process.execPath,['server.js'],{
  cwd:standalone,
  env:{...process.env,GRADING_MODE:process.env.GRADING_MODE||'test',NODE_ENV:'production',HOSTNAME:process.env.GRADING_HOST||'127.0.0.1',PORT:process.env.PORT||'3000'},
  stdio:'inherit',
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:1);});
