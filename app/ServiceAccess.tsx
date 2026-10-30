"use client";

import { useState, type RefObject } from "react";
import { Eye, EyeOff, KeyRound, ShieldCheck } from "lucide-react";

export default function ServiceAccess({config,error,provider,apiKey,onKey,keyRef,disabled,onAuthenticate,onSignOut,onRetry}:{config:any,error:string,provider:any,apiKey:string,onKey:(key:string)=>void,keyRef:RefObject<HTMLInputElement|null>,disabled:boolean,onAuthenticate:(code:string)=>Promise<boolean>,onSignOut:()=>Promise<void>,onRetry:()=>void}) {
  const [visible,setVisible]=useState(false);
  const [accessCode,setAccessCode]=useState("");
  if(!config)return <div className="key-section service-access"><strong><ShieldCheck size={17}/>批改服务</strong><p role="status">{error||"正在检查服务配置…"}</p>{error&&<button className="text-button" type="button" disabled={disabled} onClick={onRetry}>重新连接服务</button>}</div>;
  if(config.mode!=="test")return <div className="key-section service-access">
    <strong><ShieldCheck size={17}/>统一批改服务</strong>
    <p>{config.ready?"API 由负责人统一配置，无需填写个人密钥。":"服务尚未配置完成，请联系负责人。"}</p>
    {!config.ready&&config.message&&<small>{config.message}</small>}
    {config.ready&&(config.authenticated?<div className="service-authenticated"><span>✓ 已获得使用权限</span><button type="button" className="text-button" disabled={disabled} onClick={onSignOut}>退出使用</button></div>:<form onSubmit={async e=>{e.preventDefault();if(await onAuthenticate(accessCode))setAccessCode("");}}>
      <label htmlFor="service-access-code">助教访问码</label><div className="service-login"><input id="service-access-code" type="password" autoComplete="off" required value={accessCode} disabled={disabled} onChange={e=>setAccessCode(e.target.value)} placeholder="填写负责人提供的访问码"/><button className="button secondary" disabled={disabled||!accessCode.trim()}>验证</button></div><small>访问码仅用于授权使用，模型密钥留在服务端。</small>
    </form>)}
  </div>;
  return <div className="key-section service-access"><strong><KeyRound size={17}/>自行配置 API</strong><p>在下方三个步骤分别选择服务商并填写密钥。</p><small>密钥只在当前页面内存中使用，不写入进度、备份或本地存储；刷新页面后须重新填写。</small></div>;
}
