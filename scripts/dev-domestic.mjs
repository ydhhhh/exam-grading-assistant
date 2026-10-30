import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {syncPDFAssets} from './sync-pdf-assets.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
await syncPDFAssets();
const child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'dev','--webpack','--hostname',process.env.GRADING_HOST||'127.0.0.1','--port',process.env.PORT||'3000'],{
  cwd:root,
  env:{...process.env,GRADING_MODE:process.env.GRADING_MODE||'test',NEXT_TELEMETRY_DISABLED:'1'},
  stdio:'inherit',
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:1);});
