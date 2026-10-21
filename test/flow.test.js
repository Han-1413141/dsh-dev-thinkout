import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {taskFlow,arrangeFlow,flowHistory} from '../web/flow-model.js';
import {taskGraph} from '../web/graph.js';
import {ProgressPipeline} from '../src/pipeline.js';
import {StateStore} from '../src/state-store.js';

test('task parents contain work items and preserve every progress record',()=>{
  const nodes=Array.from({length:45},(_,i)=>({id:'n'+i,taskId:'page',workItem:i%2?'动画':'交互',phase:'implement',intent:'active',step:i,text:'已推进 '+i}));
  const tasks=[{id:'page',title:'制作网页',status:'active'},{id:'check',title:'检查页面',status:'planned'}];
  const before=JSON.stringify({nodes,tasks});
  const model=taskFlow({nodes,edges:[{from:'n0',to:'n1',type:'parallel'}]},tasks);
  assert.equal(model.groups.length,2);assert.equal(model.leaves.length,2);assert.equal(model.recordCount,45);
  assert.equal(model.groups[0].records.length,45);assert.equal(model.groups[1].children.length,0);
  for(const leaf of model.leaves)assert.equal(leaf.parentId,'task:page');
  assert.equal(model.groups[0].edges[0].type,'parallel');assert.equal(JSON.stringify({nodes,tasks}),before);
});

test('serial fork and join advance in logical layers while explicit parallel items share a layer',()=>{
  const items=['a','b','c','d'].map(id=>({id})),relations=[
    {from:'a',to:'b',type:'next'},{from:'a',to:'c',type:'next'},
    {from:'b',to:'c',type:'parallel'},{from:'b',to:'d',type:'next'},{from:'c',to:'d',type:'next'}];
  const plan=arrangeFlow(items,relations),columns=plan.bands[0].columns.map(col=>col.flatMap(g=>g.items.map(i=>i.id)));
  assert.deepEqual(columns,[['a'],['b','c'],['d']]);assert.equal(plan.parallelGroups.length,1);
  assert.equal(plan.edges.filter(e=>e.type==='next').length,4);
  // The same logical layers drive horizontal and vertical views; no reclassification.
  assert.deepEqual(arrangeFlow(items,relations),plan);
});

test('unassigned historical summaries stay separate and do not manufacture parallel work',()=>{
  const nodes=Array.from({length:43},(_,i)=>({id:'n'+i,phase:i%2?'plan':'implement',intent:'planned',text:'历史摘要 '+i}));
  const model=taskFlow({nodes,edges:[]},[{id:'page',title:'制作网页',status:'active'}]);
  assert.equal(model.groups.filter(g=>g.kind==='stage').length,2);
  assert.equal(model.groups.find(g=>g.id==='task:page').records.length,0);
  assert.equal(model.leaves.length,2);assert.equal(model.recordCount,43);
  const plan=arrangeFlow(model.groups,model.edges);assert.equal(plan.parallelGroups.length,0);assert.equal(plan.edges.length,0);
  assert.equal(plan.bands[0].independent,true);
});

test('conflicting serial, parallel and cycle relations remain bounded and unconfirmed',()=>{
  const items=['a','b','c','d'].map(id=>({id}));
  const plan=arrangeFlow(items,[{from:'a',to:'b',type:'next'},{from:'c',to:'d',type:'next'},
    {from:'a',to:'d',type:'parallel'},{from:'b',to:'c',type:'parallel'},{from:'b',to:'a',type:'next'}]);
  assert.equal(plan.parallelGroups.length,1);
  assert.equal(plan.edges.filter(e=>e.type==='unconfirmed').length,2);
  assert.equal(new Set(plan.bands.flatMap(b=>b.itemIds)).size,4);
  assert.ok(plan.bands.every(b=>b.columns.length<=4));
});

test('task aggregation preserves cross-task dependencies and deduplicates repeated edges',()=>{
  const nodes=[{id:'a',taskId:'page',phase:'implement',workItem:'布局'},{id:'b',taskId:'page',phase:'implement',workItem:'交互'},{id:'c',taskId:'check',phase:'verify'}];
  const model=taskFlow({nodes,edges:[{from:'a',to:'c',type:'next'},{from:'b',to:'c',type:'next'}]});
  assert.deepEqual(model.edges.map(e=>[e.from,e.to,e.type]),[['task:page','task:check','next']]);
  assert.equal(model.groups.find(g=>g.id==='task:page').kind,'task');
});

test('repeated public sentences are removed only from display history',()=>{
  const records=[{text:'正在检查页面。',at:1},{text:'正在检查页面',at:2},{summary:'已经完成移动端检查。',at:3}];
  const before=JSON.stringify(records);assert.equal(flowHistory(records).length,2);assert.equal(JSON.stringify(records),before);
});

test('orientation persists in the plugin cache and never changes tasks or requests',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jev-direction-'));
  try{
    const pipeline=new ProgressPipeline({sessionId:'direction',client:{decide(){throw Error('must not classify');}}});
    pipeline.graph.registerTask({id:'a',title:'页面',status:'active'});
    const before=JSON.stringify({graph:pipeline.snapshot().graph,messages:pipeline.snapshot().messages}),controller=pipeline.controller;
    assert.equal(pipeline.snapshot().flowDirection,'horizontal');pipeline.setFlowDirection('vertical');
    const store=new StateStore(dir);store.schedule(pipeline.snapshot());store.flush();
    const restored=new ProgressPipeline({sessionId:'direction'});restored.restore(store.read('direction'));
    assert.equal(restored.snapshot().flowDirection,'vertical');assert.equal(pipeline.controller,controller);
    assert.equal(JSON.stringify({graph:pipeline.snapshot().graph,messages:pipeline.snapshot().messages}),before);
    assert.throws(()=>pipeline.setFlowDirection('sideways'),/invalid_flow_direction/);assert.equal(pipeline.snapshot().flowDirection,'vertical');
    restored.setFlowDirection('horizontal');assert.equal(restored.snapshot().flowDirection,'horizontal');pipeline.dispose();restored.dispose();
  }finally{const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('jev-direction-'));fs.rmSync(resolved,{recursive:true,force:true});}
});

test('distinct subfeatures remain distinct after projection into parent tasks',()=>{
  const nodes=[{id:'a',taskId:'page',phase:'implement',turn:1,step:1}],messages=['动画','交互','布局'].map((workItem,i)=>({id:'m'+i,nodeId:'a',taskId:'page',workItem,goalSeq:1,turn:1,step:1,phase:'implement',kind:'stage_summary',text:'正在完成'+workItem}));
  const model=taskFlow(taskGraph({nodes,relations:[]},1,messages),[{id:'page',title:'制作页面',status:'active'}]);
  assert.deepEqual(model.leaves.map(l=>l.title),['动画','交互','布局']);
});
