import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupProgressMessages,
  groupAnchoredProgress,
  mergeProgress,
  projectProgress,
  progressStepLabel,
  progressTurnLabel,
  unwrapProgressValue,
} from '../web/chat.js';

function payload(nodes, overrides = {}, valueOverrides = {}) {
  return {
    ok: true,
    value: {
      enabled: true,
      configured: true,
      ...valueOverrides,
      state: {
        sessionId: 's1',
        issue: 'http_429',
        message: '正在调用工具 secrets',
        stats: { classified: 9, failures: 2 },
        tools: [{ name: 'shell', args: 'private' }],
        graph: { lastUpdatedAt: 1_728_000_000_000, nodes },
        ...overrides,
      },
    },
  };
}

test('projects only filtered node text and keeps tool/error details out of the chat body', () => {
  const projected = projectProgress(payload([
    { id: 'n1', text: '正在实现聊天投影。', turn: 2, step: 1, phase: 'implement', intent: 'active', lastAt: 1_728_000_100_000 },
    { id: 'n2', text: '   \n  ', turn: 2, step: 1 },
  ]), { sessionId: 's1' });

  assert.equal(projected.active, true);
  assert.equal(projected.messages.length, 1);
  assert.deepEqual(
    { text: projected.messages[0].text, turn: projected.messages[0].turn, step: projected.messages[0].step },
    { text: '正在实现聊天投影。', turn: '2', step: '1' },
  );
  const serialized = JSON.stringify(projected.messages);
  assert.equal(serialized.includes('http_429'), false);
  assert.equal(serialized.includes('正在调用工具'), false);
  assert.equal(serialized.includes('shell'), false);
  assert.equal('evidence' in projected.messages[0], false);
  assert.equal('graph' in projected.messages[0], false);
});

test('associates nodes with turn and step aliases and groups without mixing turns', () => {
  const projected = projectProgress(payload([
    { id: 'a', text: '先确认需求。', turn: 2, step: 1 },
    { id: 'b', text: '再实现。', turnId: 2, stepIndex: 2 },
    { id: 'c', text: '新的轮次。', turn: 3, assistantStep: 1 },
    { id: 'd', text: '没有轮次。' },
  ]), { sessionId: 's1' });
  const groups = groupProgressMessages(projected.messages);

  assert.deepEqual(groups.map(group => [group.key, group.messages.map(message => message.text)]), [
    ['turn:2', ['先确认需求。', '再实现。']],
    ['turn:3', ['新的轮次。']],
    ['tail', ['没有轮次。']],
  ]);
  assert.equal(progressTurnLabel('2'), '第 2 轮');
  assert.equal(progressStepLabel(2), '第 2 步');
  assert.equal(progressTurnLabel('turn:opaque'), '');
  assert.equal(progressStepLabel('step:opaque'), '');
});

test('repeated polling does not duplicate a node and a merged node updates in place', () => {
  const first = projectProgress(payload([
    { id: 'n1', text: '旧文本', turn: 1, step: 1 },
    { id: 'n2', text: '第二步', turn: 1, step: 2 },
  ]), { sessionId: 's1' });
  const once = mergeProgress(null, first);
  const again = mergeProgress(once, projectProgress(payload([
    { id: 'n1', text: '旧文本', turn: 1, step: 1 },
    { id: 'n2', text: '第二步', turn: 1, step: 2 },
  ]), { sessionId: 's1' }));

  assert.equal(again.messages.length, 2);
  assert.equal(again.messages[0], once.messages[0]);
  assert.equal(again.messages[1], once.messages[1]);

  const updated = mergeProgress(again, projectProgress(payload([
    { id: 'n1', text: '新文本', turn: 1, step: 1 },
    { id: 'n2', text: '第二步', turn: 1, step: 2 },
  ]), { sessionId: 's1' }));
  assert.equal(updated.messages.length, 2);
  assert.deepEqual(updated.messages.map(message => message.text), ['新文本', '第二步']);
  assert.equal(updated.messages[0].turn, '1');
  assert.equal(updated.messages[0].step, '1');
});

test('a duplicated node id in one snapshot keeps one message with the latest text', () => {
  const projected = projectProgress(payload([
    { id: 'dup', text: '旧内容', turn: 1, step: 1 },
    { id: 'dup', text: '最新内容', turn: 1, step: 2 },
  ]), { sessionId: 's1' });
  assert.equal(projected.messages.length, 1);
  assert.equal(projected.messages[0].text, '最新内容');
  assert.equal(projected.messages[0].step, '2');
});

test('session scope is isolated and merging a different session never leaks messages', () => {
  const leaked = projectProgress(payload([
    { id: 's2n', text: '另一个会话的进度', turn: 1, step: 1 },
  ], { sessionId: 's2' }), { sessionId: 's1' });
  assert.equal(leaked.mismatch, true);
  assert.equal(leaked.active, false);
  assert.deepEqual(leaked.messages, []);

  const s1 = mergeProgress(null, projectProgress(payload([
    { id: 's1n', text: '本会话进度', turn: 1, step: 1 },
  ], { sessionId: 's1' }), { sessionId: 's1' }));
  const switched = mergeProgress(s1, projectProgress(payload([
    { id: 's2n', text: '另一个会话的进度', turn: 1, step: 1 },
  ], { sessionId: 's2' }), { sessionId: 's2' }));

  assert.deepEqual(switched.messages.map(message => message.text), ['另一个会话的进度']);
  assert.equal(switched.messages.some(message => message.text === '本会话进度'), false);
});

test('disabled or unconfigured state hides messages and clears prior UI messages', () => {
  const before = mergeProgress(null, projectProgress(payload([
    { id: 'n1', text: '旧进度', turn: 1, step: 1 },
  ]), { sessionId: 's1' }));
  for (const override of [{ enabled: false }, { configured: false }]) {
    const next = projectProgress(payload([], {}, override), { sessionId: 's1' });
    assert.equal(next.active, false);
    const merged = mergeProgress(before, next);
    assert.deepEqual(merged.messages, []);
  }
});

test('message retention is bounded and keeps the newest progress', () => {
  const nodes = Array.from({ length: 5 }, (_, index) => ({
    id: `n${index}`,
    text: `进度 ${index}`,
    turn: 1,
    step: index + 1,
  }));
  const merged = mergeProgress(null, projectProgress(payload(nodes), { sessionId: 's1' }), { maxMessages: 3 });
  assert.deepEqual(merged.messages.map(message => message.text), ['进度 2', '进度 3', '进度 4']);
});

test('unwrap accepts the RPC envelope and a failed envelope yields an inactive projection', () => {
  assert.equal(unwrapProgressValue({ ok: true, value: { enabled: true } }).enabled, true);
  assert.equal(unwrapProgressValue({ ok: false, error: { code: 'forbidden' } }), null);
  const failed = projectProgress({ ok: false, error: { code: 'forbidden', message: 'details' } }, { sessionId: 's1' });
  assert.equal(failed.active, false);
  assert.deepEqual(failed.messages, []);
});

test('summary presentation changes independently of the status icon and updates existing messages',()=>{
  const node={id:'summary',kind:'stage_summary',text:'已找到插入位置。',turn:1,step:4};
  const value=payload([node]);value.value.state.appearance='whale';value.value.state.summaryAppearance='plain';
  const before=projectProgress(value,{sessionId:'s1'});
  assert.equal(before.messages[0].summaryAppearance,'plain');
  assert.equal(before.messages[0].appearance,'whale');
  value.value.state.summaryAppearance='tagged';
  const after=mergeProgress(before,projectProgress(value,{sessionId:'s1'}));
  assert.equal(after.messages[0].summaryAppearance,'tagged');
  assert.notEqual(after.messages[0],before.messages[0]);
});

test('standard mode shares one block per folded source group; expanded mode restores source placement',()=>{
  const messages=[
    {id:'plan',kind:'plan_summary',step:1},
    {id:'finding',kind:'stage_summary',step:4},
    {id:'result',kind:'stage_summary',step:7},
  ];
  const foldedHeader={};
  const standard=groupAnchoredProgress(messages,()=>({el:foldedHeader,after:true,folded:true}));
  assert.equal(standard.length,1);
  assert.deepEqual(standard[0].messages.map(message=>message.id),['plan','finding','result']);
  assert.equal(standard[0].folded,true);
  const sourceRows=new Map(messages.map(message=>[message.step,{}]));
  const detailed=groupAnchoredProgress(messages,message=>({el:sourceRows.get(message.step),after:true}));
  assert.deepEqual(detailed.map(group=>group.messages.map(message=>message.id)),[['plan'],['finding'],['result']]);
  assert.equal(detailed.every(group=>!group.folded),true);
  // The independent task overview must not be absorbed into progress history.
  const overview={id:'overview',kind:'task_summary',step:1};
  const sameLocation=groupAnchoredProgress([overview,...messages],()=>({el:foldedHeader,after:true,folded:true}));
  assert.equal(sameLocation.length,2);
  assert.deepEqual(sameLocation[0].messages,[overview]);
});
