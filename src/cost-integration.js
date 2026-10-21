import fs from 'node:fs';
import path from 'node:path';
/** Host-only billing bridge. No prompts, credentials, or Session objects cross it. */
export function createCostIntegration({getService,onChange=()=>{},outboxFile}) {
  const pending=new Map();let pumping=false,timer,disposed=false,saveTimer,persistenceError=false;
  if(outboxFile)try {
    if(fs.statSync(outboxFile).size<=16*1024*1024)for(const payload of JSON.parse(fs.readFileSync(outboxFile,'utf8')))
      if(payload?.protocol===1&&typeof payload.requestId==='string'&&payload.pluginId==='dsh-jev-progress')pending.set(payload.requestId,{payload,record:null});
  }catch{}
  function save(){
    clearTimeout(saveTimer);saveTimer=null;if(!outboxFile)return;
    try {fs.mkdirSync(path.dirname(outboxFile),{recursive:true});const temp=outboxFile+'.tmp';fs.writeFileSync(temp,JSON.stringify([...pending.values()].map(item=>item.payload)),{mode:0o600});fs.renameSync(temp,outboxFile);persistenceError=false;}catch{persistenceError=true;}
  }
  const scheduleSave=()=>{if(outboxFile&&!saveTimer){saveTimer=setTimeout(save,250);saveTimer.unref?.();}};
  const supported=()=>{
    const service=getService();
    return typeof service?.recordAuxiliaryUsage==='function'&&typeof service?.withAuxiliaryBilling==='function'?service:null;
  };
  async function pump(){
    if(pumping||disposed)return;pumping=true;
    try {
      const service=supported();if(!service)return;
      for(const [id,item] of pending) {
        if(disposed||getService()!==service)break;
        try {
          const receipt=await service.recordAuxiliaryUsage(item.payload);
          if(receipt?.accepted!==true)break;
          if(item.record)item.record.metering='synced';pending.delete(id);scheduleSave();onChange(item.payload.sessionId);
        } catch {break;}
      }
    } finally {
      pumping=false;clearTimeout(timer);
      if(pending.size&&!disposed){timer=setTimeout(pump,5000);timer.unref?.();}
    }
  }
  function submit(sessionId,kind,record){
    if(!record?.id||record.metering==='synced'||record.metering==='automatic')return;
    record.metering='pending';
    pending.set(record.id,{record,payload:{protocol:1,pluginId:'dsh-jev-progress',
      requestId:record.id,sessionId,kind,provider:record.provider,model:record.model,
      startedAtMs:record.at,elapsedMs:record.elapsedMs,outcome:record.outcome,
      turn:record.turn??null,step:record.step??null,usage:record.usage,
      pricing:kind==='jev-decision'?{kind:'free',source:'https://decision.vllm-sr.ai/docs'}:{kind:'catalog'},
    }});
    scheduleSave();void pump();
  }
  return {supported,submit,reconnect:pump,
    status:()=>({connected:!!getService(),compatible:!!supported(),pending:pending.size,persistenceError}),
    dispose(){disposed=true;clearTimeout(timer);save();pending.clear();}};
}
