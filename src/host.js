import { readApiKey } from './credentials.js';
import { JevClient } from './jev-client.js';
import { ProgressPipeline } from './pipeline.js';
import path from 'node:path';
import os from 'node:os';
import { StateStore } from './state-store.js';
import { primeSessionContext } from './session-context.js';
import fs from 'node:fs';
import { createNarrator } from './narrator.js';
import { createPricingReader, combineUsage } from './light-usage.js';
import { createCostIntegration } from './cost-integration.js';
import { createKeyManager } from './key-manager.js';

export const name = 'dsh-jev-progress';
export const version = '0.5.5';
export const inject = ['llm','translator'];

export async function apply(ctx, config = {}) {
  const sessions = new Map();
  const routes = new Map();
  const enabled = config.enabled !== false;
  let pricingService;
  const storageDirectory=config.storageDir || path.join(os.homedir(),'.dsh','plugin-data','jev-progress');
  const billing=createCostIntegration({getService:()=>pricingService,onChange:id=>sessions.get(id)?.changed(),outboxFile:path.join(storageDirectory,'billing-outbox.json')});
  const recordUsage=(kind,record)=>{
    const pipeline=sessions.get(record.sessionId);if(!pipeline)return;
    const ledger=kind==='jev-decision'?pipeline.jevUsage:pipeline.lightUsage;
    const saved=ledger.add(record);
    billing.submit(record.sessionId,kind,saved);pipeline.changed();
  };
  const client = new JevClient({ apiKey:await readApiKey(config.credentialFile), timeoutMs:10000,
    onUsage:record=>recordUsage('jev-decision',record) });
  let credentialService;
  const keys=createKeyManager({client,credentialFile:config.credentialFile,getCredentials:()=>credentialService});
  await keys.initialize();
  ctx.inject(['credentials'],scope=>{
    const service=scope.get('credentials');
    if(typeof service?.resolve!=='function')return;
    credentialService=service;void keys.initialize();
    scope.effect?.(()=>()=>{if(credentialService===service)credentialService=null;});
  });
  ctx.inject(['costMeter'],scope=>{
    const service=scope.get('costMeter');
    if(typeof service?.getPriceCatalog==='function')pricingService=service;
    for(const [id,pipeline] of sessions) {
      for(const record of pipeline.jevUsage.state.records)billing.submit(id,'jev-decision',record);
      for(const record of pipeline.lightUsage.state.records)billing.submit(id,'jev-summary',record);
    }
    void billing.reconnect();
    scope.effect?.(()=>()=>{if(pricingService===service)pricingService=null;});
  });
  const getPricing=createPricingReader(()=>pricingService);
  const narrator=config.naturalSummaries===false?null:createNarrator(ctx.llm,{
    getPricing,getBilling:billing.supported,onUsage:record=>recordUsage('jev-summary',record),
  });
  const summaryMode=config.summaryMode==='native'?'native':'light';
  const appearance=['orbit','whale','native','none'].includes(config.appearance)?config.appearance:'whale';
  const summaryAppearance=config.summaryAppearance==='tagged'?'tagged':'plain';
  const showStatusBar=config.showStatusBar!==false;
  const flowDirection=config.flowDirection==='vertical'?'vertical':'horizontal';
  const maxSessions = 32;
  const store = new StateStore(storageDirectory);
  if(config.runtimeStatusFile) {
    try {
      fs.writeFileSync(config.runtimeStatusFile,JSON.stringify({
        version,pid:process.pid,uiRevision:config.uiRevision??null,presentation:'stage-summary-v3',taskSummary:true,naturalSummaries:!!narrator,summaryMode,appearance,summaryAppearance,flowDirection,
        startedAt:new Date().toISOString(),configured:!!client.apiKey,
      },null,2),{mode:0o600});
    } catch {}
  }
  const allowedWorkspace = config.workspace ? path.resolve(config.workspace).toLowerCase() : null;
  const get = id => {
    if (!sessions.has(id)) {
      if (sessions.size >= maxSessions) {
        const old = [...sessions].find(([,s])=>!s.running && !s.busy);
        if (!old) return null;
        old[1].dispose(); sessions.delete(old[0]); routes.delete(old[0]);
      }
      const pipeline=new ProgressPipeline({sessionId:id,client,translator:ctx.translator,narrator,summaryMode,appearance,summaryAppearance,showStatusBar,flowDirection,outputPolicy:config.outputPolicy,onChange:state=>store.schedule(state)});
      pipeline.restore(store.read(id));
      sessions.set(id,pipeline);
      for(const record of pipeline.jevUsage.state.records)billing.submit(id,'jev-decision',record);
      for(const record of pipeline.lightUsage.state.records)billing.submit(id,'jev-summary',record);
    }
    return sessions.get(id);
  };
  // This official event observes only Agent work. Auxiliary translation calls
  // do not create an Agent stream and therefore cannot recurse into JeV.
  ctx.on('agent/assistant-stream', ({agent,frame}) => {
    if (!enabled) return;
    const id = agent?.session?.id;
    if (!id) return;
    // Agent model fields differ between host versions; request/header supplies
    // the authoritative route before assistant frames arrive.
    const session = sessions.get(String(id));
    if (session && routes.get(String(id)) === 'listening') session.onFrame(frame);
  }, {global:true});
  ctx.on('session/event', (session,event) => {
    const id = String(session.id);
    if (event.type === 'request/header') {
      const route = event.data?.header?.config;
      const workspaceMatches = !allowedWorkspace || (typeof session.header?.cwd === 'string' &&
        path.resolve(session.header.cwd).toLowerCase() === allowedWorkspace);
      const supported = enabled && workspaceMatches && route?.model === 'deepseek-flash' && ['deepseek-official','deepseek-account'].includes(route.provider);
      routes.set(id,supported ? 'listening' : !enabled ? 'disabled' : !workspaceMatches ? 'workspace_filtered' : 'unsupported_model');
      while(routes.size>128)routes.delete(routes.keys().next().value);
      if (supported) {
        const existed = sessions.has(id);
        const pipeline = get(id);
        if(pipeline)pipeline.provider=route.provider;
        if (pipeline && (!existed||!pipeline.taskGoal)) primeSessionContext(pipeline,session);
      }
      else sessions.get(id)?.cancelPending(false);
    }
    sessions.get(id)?.onEvent(event);
  }, {global:true});
  ctx.on('agent/status', ({agent,status}) => sessions.get(String(agent.session.id))?.setRunning(status==='running'), {global:true});
  ctx.inject(['connection'], connectionCtx => {
    const connection=connectionCtx.get('connection');
    // /api's single interceptor belongs to DSH's Remote gateway. An exact
    // Fetch route coexists with it and retains DSH's owner-only admission.
    const register=(method,handle)=>connection.fetch.register({path:`/api/${method}`,methods:['POST'],requestBody:'buffered',fetch:async request=>{
      let envelope;
      try {envelope=await request.json();} catch {return new Response('Invalid JSON',{status:400});}
      if(envelope?.type!=='client-request' || envelope.method!==method ||
          typeof envelope.rpcId!=='string' || !envelope.rpcId || envelope.rpcId.length>128 ||
          typeof envelope.payload?.sessionId!=='string' || !envelope.payload.sessionId || envelope.payload.sessionId.length>256) {
        return new Response('Invalid request',{status:400});
      }
      return handle(envelope);
    }});
    const result=(id,state)=>({
      version,enabled,configured:!!client.apiKey,connection:keys.status(),billingIntegration:billing.status(),summaryMode:state?.summaryMode??summaryMode,appearance:state?.appearance??appearance,summaryAppearance:state?.summaryAppearance??summaryAppearance,showStatusBar:state?.showStatusBar??showStatusBar,flowDirection:state?.flowDirection??flowDirection,
      observation:routes.get(id)||'not_observed',
      state:state?{...state,running:sessions.has(id)?state.running:false,busy:sessions.has(id)?state.busy:false}:null,
    });
    let overviewUntil=0,overview;
    register('jev-progress/overview',async envelope=>{
      if(Date.now()>overviewUntil){
        const states=new Map(store.readAll().map(state=>[state.sessionId,state]));
        for(const [id,pipeline]of sessions)states.set(id,pipeline.snapshot());
        overview={sessionId:envelope.payload.sessionId,title:'插件用量',summaryMode,appearance,summaryAppearance,showStatusBar:false,
          jevUsage:combineUsage([...states.values()].map(s=>s.jevUsage)),lightUsage:combineUsage([...states.values()].map(s=>s.lightUsage)),
          retainedSessions:states.size,graph:{nodes:[],relations:[],tasks:[]},messages:[]};overviewUntil=Date.now()+5000;
      }
      return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:result(envelope.payload.sessionId,overview)}});
    });
    register('jev-progress/state',async envelope=>{
      const id=envelope.payload.sessionId;
      let state=sessions.get(id)?.snapshot()??store.read(id);
      if(state && state.presentation!=='stage-summary-v3')state={sessionId:id,presentation:'stage-summary-v3',
        title:state.title,message:'旧版逐句记录已收起，新任务将按阶段总结展示',
        graph:{nodes:[],relations:[],tasks:[]},messages:[],running:false,busy:false,stats:{}};
      return Response.json({type:'server-response',rpcId:envelope.rpcId,
        result:{ok:true,value:result(id,state)}});
    });
    for(const method of ['import-key','check-key'])register(`jev-progress/${method}`,async envelope=>{
      try {
        if(method==='import-key')await keys.importKey(envelope.payload.key);
        else await keys.check();
        return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:result(envelope.payload.sessionId,sessions.get(envelope.payload.sessionId)?.snapshot()??store.read(envelope.payload.sessionId))}});
      }catch(error){return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:false,error:{code:/^[a-z_]{1,40}$/.test(error?.code)?error.code:'key_save_failed'}}});}
    });
    register('jev-progress/policy',async envelope=>{
      const {sessionId:id,policy}=envelope.payload;
      if(!policy||typeof policy!=='object'||Array.isArray(policy))return new Response('Invalid output policy',{status:400});
      const pipeline=get(id);if(!pipeline)return new Response('Busy',{status:503});
      pipeline.setOutputPolicy(policy);store.schedule(pipeline.snapshot());store.flush();
      return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:result(id,pipeline.snapshot())}});
    });
    register('jev-progress/mode',async envelope=>{
      const {sessionId:id,mode}=envelope.payload;
      if(!['light','native'].includes(mode))return new Response('Invalid summary mode',{status:400});
      const pipeline=get(id);
      if(!pipeline)return Response.json({type:'server-response',rpcId:envelope.rpcId,
        result:{ok:false,error:{code:'jev_sessions_busy'}}});
      pipeline.setSummaryMode(mode);
      store.schedule(pipeline.snapshot());store.flush();
      return Response.json({type:'server-response',rpcId:envelope.rpcId,
        result:{ok:true,value:result(id,pipeline.snapshot())}});
    });
    register('jev-progress/appearance',async envelope=>{
      const {sessionId:id,appearance}=envelope.payload;
      if(!['orbit','whale','native','none'].includes(appearance))return new Response('Invalid appearance',{status:400});
      const pipeline=get(id);
      if(!pipeline)return Response.json({type:'server-response',rpcId:envelope.rpcId,
        result:{ok:false,error:{code:'jev_sessions_busy'}}});
      pipeline.setAppearance(appearance);
      store.schedule(pipeline.snapshot());store.flush();
      return Response.json({type:'server-response',rpcId:envelope.rpcId,
        result:{ok:true,value:result(id,pipeline.snapshot())}});
    });
    register('jev-progress/summary-appearance',async envelope=>{
      const {sessionId:id,appearance}=envelope.payload;
      if(!['plain','tagged'].includes(appearance))return new Response('Invalid summary appearance',{status:400});
      const pipeline=get(id);
      if(!pipeline)return Response.json({type:'server-response',rpcId:envelope.rpcId,
        result:{ok:false,error:{code:'jev_sessions_busy'}}});
      pipeline.setSummaryAppearance(appearance);store.schedule(pipeline.snapshot());store.flush();
      return Response.json({type:'server-response',rpcId:envelope.rpcId,
        result:{ok:true,value:result(id,pipeline.snapshot())}});
    });
    register('jev-progress/display',async envelope=>{
      const {sessionId:id,visible}=envelope.payload;
      if(typeof visible!=='boolean')return new Response('Invalid display setting',{status:400});
      const pipeline=get(id);
      if(!pipeline)return Response.json({type:'server-response',rpcId:envelope.rpcId,
        result:{ok:false,error:{code:'jev_sessions_busy'}}});
      pipeline.setDisplay(visible);store.schedule(pipeline.snapshot());store.flush();
      return Response.json({type:'server-response',rpcId:envelope.rpcId,
        result:{ok:true,value:result(id,pipeline.snapshot())}});
    });
    register('jev-progress/flow-direction',async envelope=>{
      const {sessionId:id,direction}=envelope.payload;
      if(!['horizontal','vertical'].includes(direction))return new Response('Invalid flow direction',{status:400});
      const pipeline=get(id);if(!pipeline)return new Response('Busy',{status:503});
      pipeline.setFlowDirection(direction);store.schedule(pipeline.snapshot());store.flush();
      return Response.json({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:result(id,pipeline.snapshot())}});
    });
  });
  const service = { sessions, client, get, snapshot:id=>sessions.get(id)?.snapshot() ?? null };
  ctx.provide('jevProgress',service);
  ctx.effect(()=>()=>{ billing.dispose();for(const session of sessions.values()) {store.schedule(session.snapshot());session.dispose();} store.flush();sessions.clear();routes.clear(); });
}
