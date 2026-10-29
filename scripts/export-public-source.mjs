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
  if(name.startsWith('/')||name.split('/').includes('..')||/(^|\/)(private|secrets|runs|logs|exports|data|outputs|node_modules|\.sites-runtime|\.git)(\/|$)/.test(name)||/(^|\/)\.env($|\.)/.test(name))throw Error('Excluded source path: '+name);
  let content=git('show',revision+':'+name).toString('utf8');
  if(content.includes('\u0000')||content.includes('\ufffd'))throw Error('Non-text source requires review: '+name);
  if(name==='.openai/hosting.json')content=JSON.stringify({d1:null,r2:null},null,2)+'\n';
  if(name==='AGENTS.md')content=`# 阅卷助手源码维护约定\n\n- 当前源码为此仓库的 app/、lib/grading/ 和 tests/；先读 README.md 并检查 Git 状态。\n- 首页保持五项主要输入；按学号人工复核可选，改判理由可以留空。\n- 新批次每位学生一份学号.pdf，共m+1页：第1页姓名学号，第2至m+1页对应Q1至Qm。首页识别与评分请求分开，姓名可人工留空；异常不猜测配卷。\n- 每题只评分一次；默认最多4个并发请求，逐次串行保存；formatVersion 3为唯一格式，旧批次不转换。\n- 自动分数为建议成绩。缺页、未知和失败不能当零分；正式成绩由教师实质确认。\n- 开发与测试使用合成数据和模拟接口；不得提交学生原图、成绩、进度备份或 API key。\n- 保持输入哈希、评分点与证据校验、请求账本及预算预留；费用未定或服务异常时暂停，不自动重试。\n- 相关更改运行离线测试与类型检查。浏览器验证不能替代真实评分验收。\n- 部署时为自己的账户单独配置站点；公开仓库不含现有网站部署编号。\n- 保留已有第三方许可证，不擅自变更用户原创代码许可或全局 Git 身份。\n`;
  if(/appgprj_[a-f0-9]{16,}/.test(content)||/\/Users\/[^\s"']+/.test(content))throw Error('Private deployment or machine path in '+name);
  const dest=path.join(output,name);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,content,{mode:mode==='100755'?0o755:0o644});
  tree.push({path:name,mode,type:'blob',content});
}
mkdirSync(path.join(root,'outputs'),{recursive:true});
writeFileSync(path.join(root,'outputs','github-tree.json'),JSON.stringify(tree));
writeFileSync(path.join(root,'outputs','github-source-manifest.json'),JSON.stringify({sourceCommit:revision,files:tree.map(f=>({path:f.path,sha256:createHash('sha256').update(f.content).digest('hex')}))},null,2)+'\n');
console.log(JSON.stringify({sourceCommit:revision,files:tree.length,bytes:tree.reduce((n,f)=>n+Buffer.byteLength(f.content),0),directory:output}));
