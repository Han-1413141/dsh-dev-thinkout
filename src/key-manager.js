import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readApiKey} from './credentials.js';

const validKey=key=>typeof key==='string'&&/^sk-vsr-[A-Za-z0-9]{43}$/.test(key.trim());
const failure=code=>Object.assign(new Error(code),{code});
function writeDpapi(file,key){
  const script="$ErrorActionPreference='Stop'; $d=[Console]::In.ReadToEnd()|ConvertFrom-Json; $dir=Split-Path -Parent $d.path; [IO.Directory]::CreateDirectory($dir)|Out-Null; $s=ConvertTo-SecureString $d.key -AsPlainText -Force; $c=New-Object System.Management.Automation.PSCredential('jev',$s); $tmp=$d.path+'.tmp'; $c|Export-Clixml -LiteralPath $tmp; Move-Item -LiteralPath $tmp -Destination $d.path -Force";
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      {windowsHide:true,stdio:['pipe','ignore','ignore']});
    const timer=setTimeout(()=>{child.kill();reject(failure('key_save_failed'));},10000);
    child.once('error',()=>{clearTimeout(timer);reject(failure('key_save_failed'));});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(failure('key_save_failed'));});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({path:file,key}));
  });
}

/** Resolve native credentials first; the UI only receives availability metadata. */
export function createKeyManager({client,getCredentials=()=>null,credentialFile,fetchImpl=fetch}={}) {
  const file=credentialFile??path.join(os.homedir(),'.dsh','plugin-data','jev-progress','jev-key.xml');
  let source='none',checkedAt=null,lastError=null,quota=null,busy=false;
  async function initialize(){
    let stored;
    try {stored=await getCredentials()?.resolve?.('JEV_API_KEY');}catch{}
    if(stored?.value){client.apiKey=stored.value.trim();source='credentials';}
    else {client.apiKey=await readApiKey(file);source=client.apiKey?(process.env.JEV_API_KEY?'environment':'encrypted-file'):'none';}
  }
  async function verify(key){
    if(!validKey(key))throw failure('invalid_key');
    let response;
    try {response=await fetchImpl('https://decision.vllm-sr.ai/api/keys/self',{
      redirect:'error',headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(8000)});}catch{throw failure('key_network_error');}
    if(!response.ok){await response.body?.cancel();throw failure(response.status===401||response.status===403?'key_unauthorized':response.status===429?'key_rate_limited':'key_service_error');}
    let data;
    try {const text=await response.text();if(text.length>32000)throw 0;data=JSON.parse(text);}catch{throw failure('key_invalid_response');}
    if(data.status!=='active')throw failure('key_inactive');
    checkedAt=Date.now();lastError=null;
    quota={requests:Number.isSafeInteger(data.usage_today?.requests)?data.usage_today.requests:null,
      inputTokens:Number.isSafeInteger(data.usage_today?.input_tokens)?data.usage_today.input_tokens:null};
  }
  return {
    initialize,
    status:()=>({configured:!!client.apiKey,source,checkedAt,lastError,quota,
      writable:typeof getCredentials()?.set==='function'||process.platform==='win32'}),
    async check(){
      if(busy)throw failure('key_busy');busy=true;
      try {await verify(client.apiKey);return this.status();}
      catch(error){lastError=error.code??'key_network_error';throw error;}finally{busy=false;}
    },
    async importKey(raw){
      if(busy)throw failure('key_busy');busy=true;
      try {
        if(!validKey(raw))throw failure('invalid_key');const key=raw.trim();await verify(key);
        const credentials=getCredentials();
        if(typeof credentials?.set==='function'){await credentials.set('JEV_API_KEY',key);source='credentials';}
        else if(process.platform==='win32'){await writeDpapi(file,key);source='encrypted-file';}
        else throw failure('key_storage_unavailable');
        client.apiKey=key;return this.status();
      }catch(error){lastError=error.code??'key_save_failed';throw failure(lastError);}finally{busy=false;}
    },
  };
}
