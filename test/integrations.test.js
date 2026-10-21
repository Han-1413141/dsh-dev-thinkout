import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCostIntegration} from '../src/cost-integration.js';
import {createKeyManager} from '../src/key-manager.js';
import {JevClient} from '../src/jev-client.js';
import {normalizeOutputPolicy} from '../src/output-policy.js';
import {classifySummaries} from '../src/summary-classify.js';
import {taskOverview,taskGraph} from '../web/graph.js';
import {compactGraph} from '../web/canvas.js';
const usage={inputTokens:100,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0};

test('billing outbox survives restart and synchronizes acknowledged calls once',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'jev-outbox-')),outboxFile=path.join(directory,'outbox.json');
 let service=null,seen=[];
 const record={id:'11111111-2222-4333-8444-555555555555',at:Date.now(),elapsedMs:1,outcome:'ok',provider:'jev',model:'vllm-sr/d3-turbo',usage};
 const a=createCostIntegration({getService:()=>service,outboxFile});a.submit('session','jev-decision',record);a.dispose();
 assert.equal(JSON.parse(fs.readFileSync(outboxFile)).length,1);
 service={withAuxiliaryBilling:()=>{},recordAuxiliaryUsage:payload=>{seen.push(payload);return {accepted:true}}};
 const b=createCostIntegration({getService:()=>service,outboxFile});await b.reconnect();assert.equal(b.status().pending,0);b.dispose();
 assert.equal(seen.length,1);assert.equal(seen[0].sessionId,'session');assert.equal(seen[0].pricing.kind,'free');
 const c=createCostIntegration({getService:()=>service,outboxFile});await c.reconnect();assert.equal(seen.length,1);c.dispose();
 fs.rmSync(directory,{recursive:true,force:true});
});
test('key import verifies first, saves only to native credentials and never exposes a key',async()=>{
 const key='sk-vsr-'+'a'.repeat(43),client={},writes=[];
 const manager=createKeyManager({client,getCredentials:()=>({set:async(...args)=>writes.push(args)}),fetchImpl:async(url,options)=>{
 assert.equal(url,'https://decision.vllm-sr.ai/api/keys/self');assert.equal(options.headers.Authorization,'Bearer '+key);
 return Response.json({status:'active',usage_today:{requests:3,input_tokens:9}});
 }});
 await assert.rejects(manager.importKey('bad'),/invalid_key/);assert.equal(writes.length,0);
 await manager.importKey(key);assert.equal(client.apiKey,key);assert.deepEqual(writes,[['JEV_API_KEY',key]]);
 assert.ok(!JSON.stringify(manager.status()).includes(key));assert.equal(manager.status().quota.requests,3);
});
test('JeV receipts record real dispatch, failed-response usage and cancellations',async()=>{
 const records=[],client=new JevClient({apiKey:'test',onUsage:r=>records.push(r),fetchImpl:async()=>Response.json({model:'wrong',answers:{},usage:{input_tokens:5}})});
 await assert.rejects(client.decide({},null,{sessionId:'s'}),/invalid_response/);
 assert.equal(records[0].usage.inputTokens,5);assert.equal(records[0].outcome,'failed');
 const abort=new AbortController();abort.abort();await assert.rejects(client.decide({},abort.signal),/cancelled/);assert.equal(records.length,1);
});
function answer(request,{novelty=.75,score=2}={}){
 const preferred={phase:'implement',intent:'active',relation:'parallel',activity:'implement',update_kind:'milestone',recap:'s1',link_to:'n1'};
 return {model:'vllm-sr/d3-turbo',answers:Object.fromEntries(Object.entries(request.questions).map(([name,q])=>{
 if(q.type==='noul')return [name,{type:'noul',noul:name==='novel'?novelty:.95}];
 if(q.type==='score')return [name,{type:'score',score,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,i===Math.round(score)?1:0]))}];
 const keys=Object.keys(q.criteria),choice=keys.includes(preferred[name])?preferred[name]:keys[0];return [name,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,Number(k===choice)]))}];
 }))};
}
test('frequency and importance thresholds change inclusion while preserving semantic filtering',async()=>{
 const client={decide:async q=>({data:answer(q)})},text='I am implementing the playback controls, adding pause and speed adjustment to the page.';
 const standard=(await classifySummaries(client,[{text}])).items[0].decision;
 const less=(await classifySummaries(client,[{text,outputPolicy:{frequency:'less'}}])).items[0].decision;
 const more=(await classifySummaries(client,[{text,outputPolicy:{frequency:'more'}}])).items[0].decision;
 assert.equal(standard.novel,true);assert.equal(less.novel,false);assert.equal(more.novel,true);
 const strict=(await classifySummaries(client,[{text,outputPolicy:{strictness:'strict'}}])).items[0].decision;
 assert.equal(strict.shouldDisplay,false);assert.equal(standard.shouldDisplay,true);
 assert.equal(normalizeOutputPolicy({worth:100}).worth,.95);
 const linked=(await classifySummaries(client,[{text,priorNodes:[{id:'animation',text:'Implementing the SVG motion'}]}])).items[0].decision;
 assert.equal(linked.relation.previousNodeId,'animation');assert.equal(linked.relation.value,'parallel');
});
test('multiple features within the same activity survive graph compaction; cycles stay bounded',()=>{
 const nodes=[{id:'a',turn:1,phase:'implement',taskId:'task',text:'制作页面'},{id:'b',turn:1,phase:'verify',text:'验证页面'}];
 const notes=['播放控制','场景动画'].map((workItem,i)=>({id:'s'+i,nodeId:'a',goalSeq:1,turn:1,phase:'implement',kind:'stage_summary',workItem,text:'正在完成'+workItem}));
 const layout=compactGraph({nodes,relations:[{from:'a',to:'b',type:'next'},{from:'b',to:'a',type:'revise'}]},1,960,notes);
 assert.equal(layout.nodes.length,3);assert.equal(layout.branches.filter(b=>b.title==='播放控制'||b.title==='场景动画').length,2);
 assert.ok(layout.height<1800);for(const p of layout.positions.values()){assert.ok(p.x>=0&&p.x+250<=layout.width);assert.ok(p.y>=0);}
});

test('dense flow opens as a small overview while retaining every feature in group history',()=>{
 const nodes=Array.from({length:90},(_,i)=>({id:'n'+i,taskId:'t'+(i%6),turn:1,phase:'implement',text:'功能 '+i,workItem:'功能 '+i,intent:'active'}));
 const tasks=Array.from({length:6},(_,i)=>({id:'t'+i,title:'任务 '+i,status:'active'}));
 const view=taskOverview(taskGraph({nodes,relations:[{from:'n0',to:'n1',type:'parallel'},{from:'n1',to:'n2',type:'next'}]},1),tasks);
 assert.equal(view.groups.length,6);assert.equal(view.nodeCount,90);assert.equal(view.groups.reduce((n,g)=>n+g.nodes.length,0),90);
 assert.equal(view.groups[0].features.length,15);assert.equal(view.edges.length,2);assert.equal(view.edges[0].type,'parallel');assert.equal(view.edges[1].type,'next');
});
