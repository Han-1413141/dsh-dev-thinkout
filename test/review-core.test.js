import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressState } from '../src/core/progress-state.js';
import { redact, redactString } from '../src/core/redact.js';

const decision = (phase, relation = 'next') => ({
  ok: true, shouldDisplay: true, confidence: 0.95,
  phase: { value: phase }, intent: { value: 'active' }, relation: { value: relation },
  task: { id: 'a', title: 'Implement parser' }, sentence: { id: 's1', text: `Working: ${phase}` },
});

test('a checklist or decision cannot introduce verified completion', () => {
  const state = new ProgressState();
  assert.equal(state.registerTask({ id: 'a', title: 'A', status: 'completed' }).verified, false);
  assert.equal(state.snapshot().tasks[0].status, 'reported_done');
  const other = new ProgressState();
  other.apply({ ...decision('implement'), task: { id: 'a', title: 'A', status: 'completed' } });
  assert.equal(other.snapshot().tasks[0].verified, false);
});

test('failed commands and missing evidence cannot confirm completion', () => {
  for (const evidence of [
    { kind: 'completed' },
    { kind: 'completed', id: 'e', ok: true },
    { kind: 'tool_result', explicitTaskCompletion: true, exitCode: 1 },
    { kind: 'completed', id: 'e', source: 'host', explicitTaskCompletion: true, ok: true, revision: 0, exitCode: 1 },
  ]) {
    const state = new ProgressState();
    state.registerTask({ id: 'a', title: 'A' });
    state.recordEvidence({ taskId: 'a', ...evidence });
    assert.equal(state.snapshot().tasks[0].verified, false);
  }
});

test('completion from before a revision cannot complete the reopened task', () => {
  const state = new ProgressState();
  state.registerTask({ id: 'a', title: 'A' }, 1);
  state.recordEvidence({ kind: 'revision', taskId: 'a', id: 'r', at: 2 });
  const stale = state.recordEvidence({ kind: 'completed', taskId: 'a', id: 'e', source: 'host',
    explicitTaskCompletion: true, ok: true, revision: 0, at: 3 });
  assert.equal(stale.reason, 'stale_evidence');
  assert.equal(state.snapshot().tasks[0].status, 'active');
  const valid = state.recordEvidence({ kind: 'completed', taskId: 'a', id: 'e2', source: 'host',
    explicitTaskCompletion: true, ok: true, revision: 1, at: 4 });
  assert.equal(valid.task.verified, true);
});

test('returning to an earlier phase creates a new node, with no accidental graph cycle', () => {
  const state = new ProgressState();
  const a = state.apply(decision('implement'));
  const b = state.apply(decision('verify'), { previousNodeId: a.node.id });
  const c = state.apply(decision('implement'), { previousNodeId: b.node.id });
  assert.notEqual(c.node.id, a.node.id);
  const d = state.apply(decision('implement', 'continue'), { previousNodeId: c.node.id });
  assert.equal(d.node.id, c.node.id);
  assert.equal(state.size.nodes, 3);
});

test('task reports update active status, and snapshots do not expose nested state', () => {
  const state = new ProgressState();
  state.registerTask({ id: 'a', title: 'A', status: 'planned' });
  state.registerTask({ id: 'a', title: 'A', status: 'active' });
  assert.equal(state.snapshot().tasks[0].status, 'active');
  state.recordEvidence({ taskId: 'a', kind: 'failure', code: 'original' });
  state.snapshot().tasks[0].lastFailure.code = 'tampered';
  assert.equal(state.snapshot().tasks[0].lastFailure.code, 'original');
});

test('credential redaction handles exact assignments and deep or non-plain objects', () => {
  assert.equal(redactString('TOKEN=privatevalue'), 'TOKEN=[REDACTED]');
  assert.equal(redactString('PASSWORD=privatevalue'), 'PASSWORD=[REDACTED]');
  assert.equal(redactString('API_KEY=privatevalue'), 'API_KEY=[REDACTED]');
  const input = { a: { b: { password: 'privatevalue' } } };
  assert.ok(!JSON.stringify(redact(input, { maxDepth: 1 })).includes('privatevalue'));
  const nonplain = new Map([['token', 'privatevalue']]);
  assert.notEqual(redact(nonplain), nonplain);
});

test('an explicit pending checklist reopens a report, and cancelled nodes never merge', () => {
  const state=new ProgressState();
  state.registerTask({id:'a',title:'A',status:'reported_done'});
  state.registerTask({id:'a',title:'A',status:'planned'});
  assert.equal(state.snapshot().tasks[0].status,'planned');
  const old=state.apply(decision('implement'));
  state.nodes[0].cancelled=true;
  const next=state.apply(decision('implement','continue'),{previousNodeId:old.node.id});
  assert.notEqual(next.node.id,old.node.id);
  assert.notEqual(next.node.cancelled,true);
});
