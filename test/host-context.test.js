import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userGoal, primeSessionContext } from '../src/session-context.js';
import { ProgressPipeline } from '../src/pipeline.js';
import { apply } from '../src/host.js';
import { SUMMARY_TEMPLATES } from '../src/core/activities.js';

const human = (text,seq=1) => ({type:'user/message',seq,data:{source:{kind:'user'},content:[{type:'text',text}]}});
const translator={resolve:spec=>spec,translate:async spec=>spec.text};
function response(request) {
  const answers={};
  for(const [name,spec] of Object.entries(request.questions)) {
    if(spec.type==='noul')answers[name]={type:'noul',noul:.95};
    else if(spec.type==='score')answers[name]={type:'score',score:2,confidence:1,probabilities:{0:0,1:0,2:1,3:0,4:0}};
    else {
      const keys=Object.keys(spec.criteria);
      const preferred={phase:'plan',intent:'planned',relation:'next',sentence:'s1',task:'none',activity:'produce_files'}[name];
      const choice=keys.includes(preferred)?preferred:keys[0];
      answers[name]={type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(key=>[key,Number(key===choice)]))};
    }
  }
  const data={model:request.model,answers};
  if(request.states)data.states=Object.fromEntries(Object.entries(request.states).map(([key,value])=>[key,response(value).data]));
  return {data};
}

test('only genuine human requests update the goal; runtime notices never replace it',()=>{
  const pipeline=new ProgressPipeline({sessionId:'s',translator,client:{}});
  const log=[human('画一个鹈鹕骑车 SVG 动画'),{type:'user/message',data:{source:{kind:'runtime-context'},content:[{type:'text',text:'Runtime instructions'}]}}];
  const before=JSON.stringify(log);
  primeSessionContext(pipeline,{log});
  pipeline.onEvent({type:'user/message',data:{source:{kind:'subagent'},content:[{type:'text',text:'Background notification'}]}});
  assert.equal(pipeline.taskGoal,'画一个鹈鹕骑车 SVG 动画');
  assert.equal(pipeline.title,pipeline.taskGoal);
  assert.equal(JSON.stringify(log),before);
  assert.equal(userGoal({type:'user/message',data:{content:[{type:'text',text:'Unknown source'}]}}),null);
  pipeline.dispose();
});

test('new request header recovers earlier user goal and exposes first paragraph without a newline',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'jev-host-test-'));
  const listeners=new Map(),services={},cleanup=[];
  const endpoints=new Map();
  const connection={fetch:{register:route=>{endpoints.set(route.path,route);}}};
  const ctx={translator,on:(name,fn)=>listeners.set(name,fn),provide:(name,value)=>{services[name]=value;},
    inject:(_names,fn)=>fn({get:()=>connection}),effect:fn=>cleanup.push(fn())};
  const oldKey=process.env.JEV_API_KEY;
  process.env.JEV_API_KEY='test-local';
  try {
    await apply(ctx,{storageDir:directory});
    const seen=[];
    services.jevProgress.client.decide=async request=>{seen.push(JSON.parse(request.state));return response(request);};
    const session={id:'s',header:{cwd:'F:/another-workspace'},log:[human('Create a pelican riding a bicycle SVG.') ]};
    const before=JSON.stringify(session.log);
    const emit=event=>listeners.get('session/event')(session,event);
    emit({type:'request/header',data:{header:{config:{provider:'deepseek-official',model:'deepseek-flash'}}}});
    const frames=listeners.get('agent/assistant-stream');
    frames({agent:{session},frame:{type:'start',revision:1,attemptId:'a',turn:1,step:1}});
    frames({agent:{session},frame:{type:'chunk',revision:2,attemptId:'a',chunk:{type:'reasoning-delta',index:0,text:'I will create the animated SVG file.'}}});
    frames({agent:{session},frame:{type:'end',revision:3,attemptId:'a',outcome:{kind:'committed'}}});
    const pipeline=services.jevProgress.sessions.get('s');
    await pipeline.settle();
    assert.equal(pipeline.messages.length,2);
    assert.equal(pipeline.messages[0].kind,'task_summary');
    assert.match(pipeline.messages[0].text,/pelican/);
    assert.equal(pipeline.messages[1].text,'正在规划交付文件');
    assert.equal(pipeline.taskGoal,'Create a pelican riding a bicycle SVG.');
    assert.equal(JSON.stringify(session.log),before);
    const endpoint=endpoints.get('/api/jev-progress/state');
    const result=await endpoint.fetch(new Request('http://localhost/api/jev-progress/state',{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'1',method:'jev-progress/state',payload:{sessionId:'s'}})}));
    const body=await result.json();
    assert.equal(body.result.value.observation,'listening');
    assert.equal(body.result.value.state.messages.length,2);
    const invalid=await endpoint.fetch(new Request('http://localhost/api/jev-progress/state',{method:'POST',body:'{}'}));
    assert.equal(invalid.status,400);
    const modeEndpoint=endpoints.get('/api/jev-progress/mode');
    const change=mode=>modeEndpoint.fetch(new Request('http://localhost/api/jev-progress/mode',{method:'POST',
      body:JSON.stringify({type:'client-request',rpcId:'2',method:'jev-progress/mode',payload:{sessionId:'s',mode}})}));
    assert.equal((await change('unknown')).status,400);
    assert.equal(pipeline.summaryMode,'light');
    const switched=await (await change('native')).json();
    assert.equal(switched.result.value.state.summaryMode,'native');
    const appearanceEndpoint=endpoints.get('/api/jev-progress/appearance');
    const appearanceResult=await appearanceEndpoint.fetch(new Request('http://localhost/api/jev-progress/appearance',{method:'POST',
      body:JSON.stringify({type:'client-request',rpcId:'3',method:'jev-progress/appearance',payload:{sessionId:'s',appearance:'whale'}})}));
    assert.equal((await appearanceResult.json()).result.value.state.appearance,'whale');
    const summaryEndpoint=endpoints.get('/api/jev-progress/summary-appearance');
    const changeSummary=appearance=>summaryEndpoint.fetch(new Request('http://localhost/api/jev-progress/summary-appearance',{method:'POST',
      body:JSON.stringify({type:'client-request',rpcId:'5',method:'jev-progress/summary-appearance',payload:{sessionId:'s',appearance}})}));
    assert.equal((await changeSummary('unknown')).status,400);
    assert.equal((await (await changeSummary('tagged')).json()).result.value.state.summaryAppearance,'tagged');
    assert.equal(services.jevProgress.get('other').summaryAppearance,'plain');
    const displayEndpoint=endpoints.get('/api/jev-progress/display');
    const setDisplay=visible=>displayEndpoint.fetch(new Request('http://localhost/api/jev-progress/display',{method:'POST',
      body:JSON.stringify({type:'client-request',rpcId:'4',method:'jev-progress/display',payload:{sessionId:'s',visible}})}));
    assert.equal((await setDisplay('false')).status,400);
    const hidden=await (await setDisplay(false)).json();
    assert.equal(hidden.result.value.state.showStatusBar,false);
    assert.equal(services.jevProgress.get('other').summaryMode,'light');
    pipeline.dispose();services.jevProgress.sessions.delete('s');
    assert.equal(services.jevProgress.get('s').summaryMode,'native','mode survives plugin cache restoration');
    assert.equal(services.jevProgress.get('s').appearance,'whale');
    assert.equal(services.jevProgress.get('s').summaryAppearance,'tagged');
    assert.equal(services.jevProgress.get('s').showStatusBar,false);
    assert.equal(JSON.stringify(session.log),before,'mode changes never write conversation history');
  } finally {
    for(const dispose of cleanup)dispose();
    if(oldKey===undefined)delete process.env.JEV_API_KEY;else process.env.JEV_API_KEY=oldKey;
    const resolved=path.resolve(directory);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('jev-host-test-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});

test('a streaming burst retains its opening paragraph while the queue remains bounded',async()=>{
  const payloads=[];
  const pipeline=new ProgressPipeline({sessionId:'s',translator,client:{decide:async req=>{
    payloads.push(req);return response(req);
  }}});
  pipeline.onEvent(human('Create SVG animation'));
  for(let i=0;i<50;i++)pipeline.enqueue(`Implement animation part ${i}.`);
  assert.equal(pipeline.queue.length,16);
  assert.equal(pipeline.queue[0].text,'Implement animation part 0.');
  assert.equal(pipeline.stats.dropped,34);
  await pipeline.settle();
  assert.equal(JSON.parse(payloads[0].state).excerpt,'Implement animation part 0.');
  assert.equal(pipeline.messages.length,2);
  assert.equal(pipeline.messages[0].kind,'task_summary');
  assert.equal(pipeline.messages[1].text,SUMMARY_TEMPLATES.produce_files.planned);
  pipeline.dispose();
});
