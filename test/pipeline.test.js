import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressPipeline } from '../src/pipeline.js';
import { classifyProgress } from '../src/classify.js';
import { JevClient } from '../src/jev-client.js';
import { splitCandidateSentences } from '../src/core/questions.js';
import { SUMMARY_TEMPLATES } from '../src/core/activities.js';

function answer(request, choices = {}) {
  const answers = {};
  for (const [id,spec] of Object.entries(request.questions)) {
    if (spec.type === 'noul') answers[id] = { type:'noul', noul:.95 };
    else if (spec.type === 'score') answers[id] = { type:'score', score:2, confidence:1, probabilities:{0:0,1:0,2:1,3:0,4:0} };
    else {
      const keys = Object.keys(spec.criteria);
      const fallback = {phase:'implement',intent:'active',relation:'next',sentence:'s1',task:'none',activity:'implement'}[id];
      const choice = choices[id] ?? (keys.includes(fallback)?fallback:keys[0]);
      answers[id] = { type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(key=>[key,key===choice?1:0])) };
    }
  }
  const data = {model:request.model,answers};
  if(request.states) data.states=Object.fromEntries(Object.entries(request.states).map(([id,state])=>[id,answer(state,choices).data]));
  return { data };
}
const translator = { resolve:spec=>spec, translate:async spec=>`进度：${spec.text}` };
const deferred = () => { let resolve; const promise = new Promise(r=>resolve=r); return {promise,resolve}; };
const frame = (type,revision,extra={}) => ({type,revision,attemptId:'s:1',...extra});

test('routine activity notes never force a recap just because more paragraphs arrive',async()=>{
  const inputs=[];
  const pipeline=new ProgressPipeline({sessionId:'s',translator,
    client:{decide:async payload=>answer(payload,{activity:'research',intent:'active',update_kind:'progress',recap:'none'})},
    narrator:async input=>{inputs.push(input);return {status:'正在检查进度组件',summary:''};}});
  pipeline.enqueue('I am reading the progress component to locate its message insertion point.');
  await pipeline.settle();
  pipeline.enqueue('I am comparing the collapsed step containers.');
  await pipeline.settle();
  assert.equal(pipeline.messages.filter(row=>row.kind==='progress').length,1);
  assert.equal(pipeline.messages.filter(row=>row.kind==='stage_summary').length,0);
  assert.equal(inputs.length,1);
  pipeline.dispose();
});

test('later milestones survive same-activity dedup and retain their own source steps in both modes',async()=>{
  for(const mode of ['light','native']) {
    const inputs=[],translated=[];
    const pipeline=new ProgressPipeline({sessionId:'s',summaryMode:mode,
      client:{decide:async payload=>answer(payload,{activity:'research',intent:'active',update_kind:'milestone',recap:'whole'})},
      translator:{resolve:spec=>spec,translate:async spec=>{translated.push(spec);return spec.text.includes('hidden')?'已定位摘要消失的原因：插入位置位于隐藏容器中。':'已确认后续摘要被同阶段去重覆盖，需要保留每个步骤的新结论。';}},
      narrator:async input=>{inputs.push(input);return {status:'正在检查进度显示',summary:input.text.includes('hidden')?'已定位摘要消失的原因：插入位置位于隐藏容器中。':'已确认后续摘要被同阶段去重覆盖，需要保留每个步骤的新结论。'};}});
    pipeline.onEvent({type:'turn/start',data:{turn:1}});
    for(const [step,text] of [[2,'The missing summaries are inside a hidden container. This explains why they disappear.'],[5,'Later summaries overwrite earlier findings from the same phase. We must retain their source steps.']]) {
      const attemptId='s:'+step,revision=step*10;
      pipeline.onFrame({type:'start',revision,attemptId,turn:1,step});
      pipeline.onFrame({type:'chunk',revision:revision+1,attemptId,chunk:{type:'reasoning-delta',index:0,text:text+'\n'}});
      pipeline.onFrame({type:'end',revision:revision+2,attemptId,outcome:{kind:'committed'}});
      await pipeline.settle();
    }
    const summaries=pipeline.messages.filter(row=>row.kind==='stage_summary');
    assert.equal(summaries.length,2,mode);
    assert.deepEqual(summaries.map(row=>row.step),[2,5]);
    assert.equal(new Set(summaries.map(row=>row.id)).size,2);
    if(mode==='native') {assert.equal(inputs.length,0);assert.equal(translated.length,2);}
    else {assert.equal(inputs[1].kind,'milestone');assert.equal(inputs[1].publishedSummaries.length,1);}
    pipeline.dispose();
  }
});

test('native mode translates the selected recap without a narrator or main Session',async()=>{
  const translated=[];let narratorCalls=0;
  const pipeline=new ProgressPipeline({sessionId:'main',summaryMode:'native',
    narrator:async()=>{narratorCalls++;throw Error('must not be used');},
    client:{decide:async payload=>answer(payload,{activity:'produce_files',intent:'planned',update_kind:'plan',recap:'whole'})},
    translator:{resolve:spec=>{
      assert.equal(spec.sessionId,undefined);
      if(!spec.provider)throw Object.assign(Error('paid provider'),{code:'TRANSLATION_SESSION_REQUIRED'});
      assert.equal(spec.provider,'bing');return spec;
    },translate:async spec=>{translated.push(spec);return '数据已读取，文件尚未生成和检查。正在规划分类统计、导出文件并核对总数。';}},
  });
  const excerpt='The data is loaded, but the file has not been created or checked. I will count the categories, export the file, and verify the total.';
  pipeline.enqueue(excerpt);await pipeline.settle();
  assert.equal(narratorCalls,0);
  assert.equal(translated.length,1);
  assert.equal(translated[0].text,excerpt);
  assert.equal(pipeline.messages.filter(message=>message.kind==='plan_summary').length,1);
  assert.equal(pipeline.messages[0].intent,'planned');
  assert.equal(pipeline.stats.narrated,0);
  pipeline.dispose();
});

test('switching mode aborts old rewriting and ignores a late result without duplicating status',async()=>{
  const started=deferred(),pending=deferred();let signal;
  const pipeline=new ProgressPipeline({sessionId:'s',translator,
    narrator:async(_input,currentSignal)=>{signal=currentSignal;started.resolve();return pending.promise;},
    client:{decide:async payload=>answer(payload,{activity:'implement',intent:'active',update_kind:'summary',recap:'s1'})}});
  pipeline.enqueue('The parser is implemented and the first checks passed.');
  await started.promise;
  pipeline.setSummaryMode('native');
  assert.equal(signal.aborted,true);
  pipeline.enqueue('The renderer is integrated and its checks passed.');
  pending.resolve({status:'旧模式的延迟结果',summary:'不应该显示的旧摘要'});
  await pipeline.settle();
  assert.equal(pipeline.snapshot().summaryMode,'native');
  assert.equal(pipeline.stats.narrated,0);
  assert.ok(!JSON.stringify(pipeline.messages).includes('旧'));
  assert.equal(pipeline.messages.filter(message=>message.kind==='progress').length,1);
  assert.ok(pipeline.messages.some(message=>message.kind==='stage_summary'));
  pipeline.dispose();
});

test('slow natural summaries do not block initial progress or the next JeV decision',async()=>{
  const rewrite=deferred(),started=deferred();
  let calls=0;
  const pipeline=new ProgressPipeline({sessionId:'s',translator,
    narrator:async()=>{started.resolve();return rewrite.promise;},
    client:{decide:async payload=>{calls++;return answer(payload,{activity:calls===1?'plan':'verify',intent:'active'});}}});
  pipeline.onFrame(frame('start',1,{turn:1,step:1}));
  pipeline.onFrame(frame('chunk',2,{chunk:{type:'reasoning-delta',index:0,text:'I am planning the task.\n'}}));
  await started.promise;
  assert.equal(pipeline.messages[0].text,'正在梳理任务方案');
  pipeline.onFrame(frame('chunk',3,{chunk:{type:'reasoning-delta',index:0,text:'I am checking the result.\n'}}));
  for(let n=0;n<50&&calls<2;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls,2);
  rewrite.resolve({status:'Checking the result',summary:''});
  await pipeline.settle();
  assert.equal(pipeline.graph.nodes.length,2);
  pipeline.dispose();
});

test('selected sentence is reclassified without borrowing another sentence labels', async () => {
  const seen = [];
  const client = { decide:async request=>{
    seen.push(JSON.parse(request.state).excerpt);
    return seen.length===1 ? answer(request,{sentence:'s2',phase:'implement',intent:'reported_done'})
      : answer(request,{phase:'verify',intent:'planned'});
  } };
  const {decision,calls} = await classifyProgress(client,{text:'The parser is implemented. I will run integration checks next.'});
  assert.equal(calls,2);
  assert.equal(seen[1],'I will run integration checks next.');
  assert.equal(decision.phase.value,'verify');
  assert.equal(decision.intent.value,'planned');
});

test('sentence splitting retains following caveats and never cuts a long sentence', () => {
  assert.deepEqual(splitCandidateSentences('The checks passed. However, deployment is still untested.'), ['The checks passed.  However, deployment is still untested.'].map(x=>x.replace(/\s+/g,' ')));
  assert.deepEqual(splitCandidateSentences('a'.repeat(1100)+' but none of this is complete.'),[]);
});

test('abandoned attempt cannot publish a late decision; disposal settles', async () => {
  const pending = deferred(), started=deferred();
  let request;
  const pipeline = new ProgressPipeline({sessionId:'s',translator,client:{decide:async payload=>{request=payload;started.resolve();return pending.promise;}}});
  pipeline.onFrame(frame('start',1));
  pipeline.onFrame(frame('chunk',2,{time:Date.now(),chunk:{type:'reasoning-delta',index:0,text:'Implement the parser now.\n'}}));
  await started.promise;
  pipeline.onFrame(frame('end',3,{outcome:{kind:'abandoned'}}));
  pending.resolve(answer(request));
  await pipeline.settle();
  assert.equal(pipeline.snapshot().graph.nodes.length,0);
  assert.equal(pipeline.busy,false);
  pipeline.dispose();
  await pipeline.settle();
});

test('overlong credential lines never send separated secret fragments', async () => {
  const payloads = [];
  const pipeline = new ProgressPipeline({sessionId:'s',translator,client:{decide:async payload=>{payloads.push(payload);return answer(payload);}}});
  pipeline.onFrame(frame('start',1));
  pipeline.onFrame(frame('chunk',2,{chunk:{type:'reasoning-delta',index:0,text:'TOKEN='+'x'.repeat(17000)}}));
  pipeline.onFrame(frame('chunk',3,{chunk:{type:'reasoning-delta',index:0,text:'hidden-tail\nImplement the parser.\n'}}));
  pipeline.onFrame(frame('end',4,{outcome:{kind:'committed'}}));
  await pipeline.settle();
  assert.equal(payloads.length,1);
  assert.ok(!JSON.stringify(payloads).includes('hidden-tail'));
  assert.equal(pipeline.stats.oversized,1);
});

test('burst backlog is bounded and distinguishes dropped from merged paragraphs', async () => {
  const pending = deferred();let request;
  const pipeline = new ProgressPipeline({sessionId:'s',translator,client:{decide:async payload=>{request=payload;return pending.promise;}}});
  for(let n=0;n<50;n++)pipeline.enqueue(`Implement module ${n}.`);
  assert.equal(pipeline.queue.length,16);
  assert.equal(pipeline.stats.dropped,34);
  assert.equal(pipeline.stats.coalesced,0);
  pipeline.dispose();pending.resolve(request ? answer(request) : {});
  await pipeline.settle();
});

test('batched paragraphs keep source order and fenced code is never classified', async () => {
  const payloads=[];
  const pipeline=new ProgressPipeline({sessionId:'s',translator,client:{decide:async payload=>{
    payloads.push(payload);
    const result=answer(payload);
    if(payload.states?.p1)result.data.states.p1=answer(payload.states.p1,{activity:'integrate'}).data;
    return result;
  }}});
  pipeline.onFrame(frame('start',1,{turn:2,step:3}));
  pipeline.onFrame(frame('chunk',2,{chunk:{type:'reasoning-delta',index:0,text:
    'Implement the parser.\n```js\nTests pass.\n```\nCheck the renderer.\n'}}));
  await pipeline.settle();
  assert.equal(payloads.length,1);
  assert.equal(Object.keys(payloads[0].states).length,1);
  assert.ok(!JSON.stringify(payloads).includes('Tests pass'));
  const messages=pipeline.snapshot().messages;
  assert.equal(messages.length,1);
  assert.deepEqual(messages[0].parts.map(part=>part.text),[
    `正在进度：${SUMMARY_TEMPLATES.implement.active}`,`正在进度：${SUMMARY_TEMPLATES.integrate.active}`]);
  assert.equal(messages[0].turn,2);
  assert.ok(!messages[0].text.includes('Check the renderer'));
  pipeline.dispose();
});

test('429 cooldown applies to queued requests and does not launch another fetch', async () => {
  const pending = deferred();let fetches=0;
  const client = new JevClient({apiKey:'test',maxConcurrent:1,fetchImpl:async()=>{fetches++;return pending.promise;}});
  const a = client.decide({}).catch(error=>error.code);
  const b = client.decide({}).catch(error=>error.code);
  pending.resolve(new Response('',{status:429,headers:{'Retry-After':'3'}}));
  assert.deepEqual(await Promise.all([a,b]),['http_429','rate_limited']);
  assert.equal(fetches,1);
  assert.equal(client.active,0);
});

test('native translator failure is isolated from the Agent and leaves no fabricated node', async () => {
  const pipeline = new ProgressPipeline({sessionId:'s',client:{decide:async payload=>answer(payload)},
    translator:{resolve:spec=>spec,translate:async()=>{throw Error('translation unavailable');}}});
  pipeline.enqueue('Implement the parser.');
  await pipeline.settle();
  assert.equal(pipeline.stats.failures,1);
  assert.equal(pipeline.graph.size.nodes,0);
  assert.equal(pipeline.busy,false);
});

test('a delayed decision does not overwrite a newer checklist report', async () => {
  const pending=deferred(),started=deferred();let request;
  const pipeline=new ProgressPipeline({sessionId:'s',translator,client:{decide:async payload=>{
    request=payload;started.resolve();return pending.promise;
  }}});
  pipeline.onEvent({type:'todo/write',data:{todos:[{content:'Parser',status:'in_progress'}]}});
  pipeline.enqueue('Implement the parser.');
  await started.promise;
  pipeline.onEvent({type:'todo/write',data:{todos:[{content:'Parser',status:'completed'}]}});
  pending.resolve(answer(request,{task:'t1',intent:'active'}));
  await pipeline.settle();
  assert.equal(pipeline.snapshot().graph.tasks[0].status,'reported_done');
  assert.equal(pipeline.snapshot().graph.tasks[0].verified,false);
  pipeline.dispose();
});

test('cancelled request releases the queue, identical retry displays, and cancelled reports revert', async () => {
  const started=deferred();let count=0;
  const pipeline=new ProgressPipeline({sessionId:'s',translator,client:{decide:async(payload,signal)=>{
    if(++count>1)return answer(payload,{task:'t1',intent:'reported_done'});
    started.resolve();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'cancelled'})),{once:true}));
  }}});
  pipeline.onEvent({type:'todo/write',data:{todos:[{content:'Parser',status:'in_progress'}]}});
  pipeline.onFrame(frame('start',1));
  pipeline.onFrame(frame('chunk',2,{chunk:{type:'reasoning-delta',index:0,text:'The parser is implemented.\n'}}));
  await started.promise;
  pipeline.onFrame(frame('end',3,{outcome:{kind:'abandoned'}}));
  pipeline.onFrame({...frame('start',4),attemptId:'s:2'});
  pipeline.onFrame({...frame('chunk',5,{chunk:{type:'reasoning-delta',index:0,text:'The parser is implemented.\n'}}),attemptId:'s:2'});
  await pipeline.settle();
  assert.equal(pipeline.snapshot().messages.length,1);
  assert.equal(pipeline.snapshot().graph.tasks[0].status,'reported_done');
  pipeline.onFrame({...frame('end',6,{outcome:{kind:'abandoned'}}),attemptId:'s:2'});
  assert.equal(pipeline.snapshot().graph.tasks[0].status,'active');
  pipeline.dispose();
});

test('a lone surviving candidate is classified independently of filtered text', async () => {
  const seen=[];
  const {decision,calls}=await classifyProgress({decide:async request=>{
    seen.push(JSON.parse(request.state).excerpt);
    return answer(request,{intent:seen.length===1?'reported_done':'planned'});
  }},{text:'Implemented '+ 'x'.repeat(950)+'. Next inspect the renderer.'});
  assert.equal(calls,2);
  assert.equal(seen[1],'Next inspect the renderer.');
  assert.equal(decision.intent.value,'planned');
});

test('final status waits for delayed progress, updates it in place, and leaves the main log untouched',async()=>{
  const pipeline=new ProgressPipeline({sessionId:'s',translator,client:{decide:async request=>{
    const isFinal=JSON.parse(request.state).excerpt.includes('CSV is saved');
    return answer(request,{activity:'produce_files',intent:isFinal?'reported_done':'planned'});
  }}});
  pipeline.onFrame(frame('start',1,{turn:1,step:1}));
  pipeline.onFrame(frame('chunk',2,{chunk:{type:'reasoning-delta',index:0,text:'I will create the CSV file.\n'}}));
  pipeline.onFrame(frame('end',3,{outcome:{kind:'committed'}}));
  const events=[
    {type:'assistant/message',data:{message:{content:[{type:'text',text:'The CSV is saved with 16 rows.'}]}}},
    {type:'turn/end',data:{reason:{kind:'completed'}}},
  ];
  const original=JSON.stringify(events);
  events.forEach(event=>pipeline.onEvent(event));
  await pipeline.settle();
  assert.equal(pipeline.messages.length,1);
  assert.equal(pipeline.messages[0].intent,'reported_done');
  assert.equal(pipeline.graph.nodes.length,1);
  assert.equal(pipeline.graph.nodes[0].intent,'reported_done');
  assert.equal(pipeline.graph.nodes[0].verified,false);
  assert.equal(JSON.stringify(events),original);
  pipeline.dispose();
});

test('distinct later findings in one long thought can finish out of order without cancelling each other',async()=>{
  const earlier=deferred(),started=deferred();let calls=0;
  const pipeline=new ProgressPipeline({sessionId:'s',translator,
    client:{decide:async request=>answer(request,{activity:'research',intent:'active',update_kind:'milestone',recap:'s1'})},
    narrator:async()=>{
      calls++;
      if(calls===1){started.resolve();return earlier.promise;}
      return {status:'正在检查阶段结果',summary:'后续已找到过程组折叠导致摘要不可见的原因。'};
    }});
  pipeline.onFrame({type:'start',revision:1,attemptId:'long',turn:1,step:1});
  pipeline.onFrame({type:'chunk',revision:2,attemptId:'long',chunk:{type:'reasoning-delta',index:0,text:'The observer is connected and the first progress is visible.\n'}});
  await started.promise;
  pipeline.onFrame({type:'chunk',revision:3,attemptId:'long',chunk:{type:'reasoning-delta',index:0,text:'The hidden process container explains why later summaries disappear.\n'}});
  for(let n=0;n<50&&calls<2;n++)await new Promise(resolve=>setTimeout(resolve,10));
  earlier.resolve({status:'正在检查事件接入',summary:'实时事件已经接通，首条进度现已显示。'});
  await pipeline.settle();
  const summaries=pipeline.messages.filter(row=>row.kind==='stage_summary');
  assert.equal(summaries.length,2);
  assert.equal(new Set(summaries.map(row=>row.sourceOffset)).size,2);
  assert.equal(pipeline.messages.filter(row=>row.kind==='progress').length,1);
  pipeline.dispose();
});
