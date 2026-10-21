import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressReports } from '../src/progress-reports.js';

const update=(activity,intent='active',extra={})=>({
  activity,intent,text:`${activity}: ${intent}`,phase:'implement',turn:1,step:1,goalSeq:3,
  taskId:null,attemptId:'a',at:100,sourceAt:90,...extra
});

test('one batch becomes one report and repeated details do not create chat messages',()=>{
  const reports=new ProgressReports({now:()=>100});
  reports.offer([update('visual'),update('motion'),update('visual')]);
  assert.equal(reports.messages.length,1);
  assert.equal(reports.messages[0].parts.length,2);
  for(let i=0;i<20;i++)reports.offer([update('visual')]);
  assert.equal(reports.messages.length,1);
  assert.equal(reports.pending.size,0);
  assert.equal(reports.suppressed,21);
  reports.dispose();
});

test('updates are driven by new content, with no fixed time delay',()=>{
  let time=100;
  const reports=new ProgressReports({now:()=>time});
  reports.offer([update('visual')]);
  reports.offer([update('motion')]);
  assert.equal(reports.messages.length,1);
  assert.equal(reports.messages[0].parts.length,2);
  assert.equal(reports.messages[0].at,100);
  reports.dispose();
});

test('a phase transition creates a new report; a new status replaces obsolete wording',()=>{
  let time=100;
  const reports=new ProgressReports({now:()=>time});
  reports.offer([update('artifact','planned')]);
  time++;reports.offer([update('artifact','active')]);
  assert.equal(reports.messages.length,1);
  assert.equal(reports.messages[0].text,'artifact: active');
  time++;reports.offer([update('artifact','reported_done')]);
  assert.equal(reports.messages.length,1);
  assert.equal(reports.messages[0].text,'artifact: reported_done');
  time++;reports.offer([update('verification','active',{phase:'verify'})]);
  assert.equal(reports.messages.length,2);
  reports.dispose();
});

test('cancellation removes pending work and permits an identical retry',()=>{
  const reports=new ProgressReports({now:()=>100});
  reports.offer([update('visual')]);
  reports.offer([update('motion')]);
  reports.cancel('a');
  assert.equal(reports.pending.size,0);
  assert.equal(reports.messages[0].cancelled,true);
  assert.equal(reports.has(update('visual')),false);
  reports.offer([update('visual','active',{attemptId:'retry'})],{finished:true});
  assert.equal(reports.messages.length,2);
  assert.equal(reports.messages[1].cancelled,undefined);
  reports.dispose();
});

test('a real verification retry updates its phase without creating a duplicate row',()=>{
  const reports=new ProgressReports({now:()=>100});
  reports.offer([update('verify','active',{phase:'verify'}),update('fix','active',{phase:'debug'})]);
  reports.offer([update('verify','active',{phase:'verify',step:3,relation:'revise',novel:true,text:'正在重新检查修复结果'})]);
  assert.equal(reports.messages.length,2);
  assert.deepEqual(reports.messages.map(message=>message.stage),['verify','debug']);
  assert.equal(reports.messages[0].text,'正在重新检查修复结果');
  reports.dispose();
});

test('repeated plans cannot regress active work, even after intervening phases and task drift',()=>{
  const reports=new ProgressReports();
  reports.offer([update('environment','planned',{phase:'understand'})]);
  reports.offer([update('environment','active',{phase:'understand'})]);
  reports.offer([update('plan','active',{phase:'plan'})]);
  for(let i=0;i<20;i++)reports.offer([update('environment','planned',{phase:'implement',taskId:`task-${i}`})]);
  assert.equal(reports.messages.length,2);
  assert.equal(reports.messages[0].intent,'active');
  assert.equal(reports.messages[0].text,'environment: active');
});

test('the model recap is separate, phase-coalesced, and repeated sentences are omitted',()=>{
  const reports=new ProgressReports();
  const first=update('visual','planned',{updateKind:'plan',novel:true,summary:'先设计主体与运动关系，再生成动画文件。'});
  reports.offer([first,first]);
  assert.equal(reports.messages.length,2);
  assert.equal(reports.messages[1].kind,'plan_summary');
  reports.offer([update('motion','planned',{updateKind:'plan',novel:true,summary:'动画采用循环运动，人物与车轮保持同步。'})]);
  assert.equal(reports.messages.length,2);
  assert.equal(reports.messages[1].text,'动画采用循环运动，人物与车轮保持同步。');
});

test('cancelling a merged attempt retains already committed facts',()=>{
  const reports=new ProgressReports({now:()=>100});
  reports.offer([update('visual','active',{attemptId:'committed'})]);
  reports.offer([update('motion','active',{attemptId:'abandoned'})]);
  reports.cancel('abandoned');
  assert.equal(reports.messages.length,1);
  assert.equal(reports.messages[0].cancelled,undefined);
  assert.equal(reports.messages[0].text,'visual: active');
  assert.equal(reports.messages[0].attemptId,'committed');
  reports.dispose();
});

test('a task summary is emitted once and the final answer reconciles existing progress',()=>{
  const reports=new ProgressReports({now:()=>100});
  const summary={goalSeq:3,turn:1,text:'本轮任务：制作 SVG 动画',sourceAt:90};
  reports.setTaskSummary(summary);
  reports.setTaskSummary(summary);
  reports.offer([update('artifact','planned')]);
  reports.reconcile([update('artifact','reported_done')]);
  assert.equal(reports.messages.length,2);
  assert.equal(reports.messages[0].kind,'task_summary');
  assert.equal(reports.messages[1].text,'artifact: reported_done');
  assert.equal(reports.messages[1].intent,'reported_done');
  reports.dispose();
});

test('new later recaps remain at their source step instead of replacing an earlier recap',()=>{
  const reports=new ProgressReports();
  reports.offer([update('research','active',{updateKind:'milestone',novel:true,summary:'已定位重复显示来自同阶段覆盖。'})]);
  reports.offer([update('research','active',{step:4,attemptId:'later',updateKind:'summary',novel:true,summary:'插入位置也已查明，位于折叠过程组之前。'})]);
  const summaries=reports.messages.filter(row=>row.kind==='stage_summary');
  assert.equal(summaries.length,2);
  assert.deepEqual(summaries.map(row=>row.step),[1,4]);
  reports.offer([update('research','active',{step:7,updateKind:'summary',novel:true,summary:summaries[0].text})]);
  assert.equal(reports.messages.filter(row=>row.kind==='stage_summary').length,2);
});
