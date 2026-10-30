import {access,cp,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const standalone=path.join(root,'.next/standalone');
await access(path.join(standalone,'server.js'));
await mkdir(path.join(standalone,'.next'),{recursive:true});
await cp(path.join(root,'.next/static'),path.join(standalone,'.next/static'),{recursive:true});
await cp(path.join(root,'public'),path.join(standalone,'public'),{recursive:true});
console.log('Standalone server and local PDF assets ready in .next/standalone.');
