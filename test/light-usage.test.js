import test from 'node:test';
import assert from 'node:assert/strict';
import {LightUsage,normalizeUsage,estimateUsage,createPricingReader} from '../src/light-usage.js';
import {createNarrator} from '../src/narrator.js';
import {progressHistory} from '../web/canvas.js';

test('usage uses disjoint token buckets and does not turn missing costs into zero',()=>{
  const usage=normalizeUsage({inputTokens:1000,cacheReadTokens:2000,outputTokens:100});
  assert.equal(usage.totalTokens,3100);
  const pricing={currency:'CNY',entry:{offPeak:{cacheMiss:1,cacheHit:.02,output:4},peak:{cacheMiss:2,cacheHit:.04,output:8}}};
  const estimate=estimateUsage(usage,pricing);
  assert.equal(estimate.low,.00144);assert.equal(estimate.high,.00288);
  const ledger=new LightUsage();
  ledger.add({at:1,outcome:'ok',usage,pricing});
  ledger.add({at:2,outcome:'cancelled',usage:null});
  const state=ledger.snapshot();
  assert.equal(state.calls,2);assert.equal(state.pricedCalls,1);assert.equal(state.missingUsage,1);
  assert.equal(state.cancelled,1);assert.equal(state.records[1].estimate,null);
  assert.equal(state.records[1].usage,null);
  const restored=new LightUsage();restored.restore(state);
  assert.deepEqual(restored.snapshot(),state);
});

test('a billed auxiliary call is recorded even when invalid output is rejected',async()=>{
  const records=[];
  const llm={prepareCall:async config=>({config,stream:async function*(){
    yield {type:'text-delta',text:'invalid output'};
    yield {type:'usage',usage:{inputTokens:20,outputTokens:5,cacheReadTokens:80}};
    yield {type:'finish',reason:{kind:'stop'}};
  }})};
  const narrator=createNarrator(llm,{onUsage:record=>records.push(record)});
  await assert.rejects(narrator({sessionId:'s',text:'public work',kind:'summary'},new AbortController().signal));
  assert.equal(records.length,1);assert.equal(records[0].outcome,'failed');
  assert.equal(records[0].usage.totalTokens,105);assert.equal(records[0].sessionId,'s');
  assert.equal('text' in records[0],false);
});

test('history folds activities, excludes other requests and cancelled rows',()=>{
  const state={goalSeq:2,messages:[
    {kind:'progress',goalSeq:1,activity:'old',text:'旧任务'},
    {kind:'progress',goalSeq:2,parts:[{activity:'read',text:'读取中',sourceAt:1},{activity:'check',text:'核对中',sourceAt:2}]},
    {kind:'progress',goalSeq:2,activity:'read',text:'已读取',sourceAt:3},
    {kind:'progress',goalSeq:2,cancelled:true,activity:'discard',text:'已取消'},
  ]};
  assert.deepEqual(progressHistory(state).map(row=>row.text),['核对中','已读取']);
});

test('pricing reads the installed catalog and retains its currency without constants',async()=>{
  const read=createPricingReader(()=>({getPriceCatalog:async()=>({deepseek:{'DeepSeek v4.1':{'deepseek-flash':{cacheMiss:7,cacheHit:1,output:9}}}}),
    getLocalState:async()=>({config:{prices:{currency:'CNY'}}})}));
  const pricing=await read();assert.equal(pricing.currency,'CNY');assert.equal(pricing.entry.cacheMiss,7);
});
