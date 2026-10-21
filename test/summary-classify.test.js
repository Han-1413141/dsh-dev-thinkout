import test from 'node:test';
import assert from 'node:assert/strict';

import { classifySummaries } from '../src/summary-classify.js';
import { INTENTS } from '../src/core/questions.js';
import {
  ACTIVITIES,
  ACTIVITY_CRITERIA,
  ACTIVITY_IDS,
  ACTIVITY_NONE,
  SUMMARY_TEMPLATES,
} from '../src/core/activities.js';

/**
 * A deliberately fake JeV interface. It validates the request protocol and
 * template wiring only; it makes no claim about semantic classification.
 */
function responseFor(plan, preferred = {}) {
  const answers = {};
  const defaults = {
    phase: 'implement',
    intent: 'active',
    relation: 'next',
    activity: 'environment',
    task: 't1',
  };

  for (const [id, spec] of Object.entries(plan.questions)) {
    if (spec.type === 'noul') {
      answers[id] = {
        type: 'noul',
        noul: typeof preferred.worth === 'number' ? preferred.worth : 0.9,
      };
      continue;
    }
    if (spec.type === 'score') {
      const target = Math.min(2, spec.criteria.length - 1);
      const probabilities = {};
      spec.criteria.forEach((_label, index) => {
        probabilities[String(index)] = index === target
          ? 0.6
          : 0.4 / (spec.criteria.length - 1);
      });
      answers[id] = {
        type: 'score',
        score: target,
        probabilities,
        confidence: 0.9,
      };
      continue;
    }
    if (spec.type !== 'choice') throw new Error(`fake response does not support ${spec.type}`);
    const options = Object.keys(spec.criteria);
    const wanted = preferred[id] ?? defaults[id];
    const choice = wanted !== undefined && Object.hasOwn(spec.criteria, wanted)
      ? wanted
      : options[0];
    const rest = options.length > 1 ? 0.2 / (options.length - 1) : 0;
    answers[id] = {
      type: 'choice',
      choice,
      probabilities: Object.fromEntries(options.map(option => [
        option,
        option === choice ? 0.8 : rest,
      ])),
      confidence: 0.9,
    };
  }

  return { model: plan.model, answers };
}

function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    async decide(payload, signal) {
      calls.push({ payload, signal });
      const data = respond(payload);
      if (payload.states) {
        data.states = {};
        for (const [key, state] of Object.entries(payload.states)) {
          data.states[key] = respond({ ...state, model: payload.model });
        }
      }
      return { data };
    },
  };
}

async function classify(contexts, preferred = {}, mutateResponse) {
  const client = fakeClient((request) => {
    const response = responseFor(request, preferred);
    if (mutateResponse) mutateResponse(response, request);
    return response;
  });
  const result = await classifySummaries(client, contexts, new AbortController().signal);
  return { ...result, client };
}

test('controlled summaries bind activity and intent to complete local templates', async () => {
  assert.ok(ACTIVITIES.length >= 10 && ACTIVITIES.length <= 14);
  assert.equal(ACTIVITY_IDS.length, ACTIVITIES.length);
  assert.equal(typeof ACTIVITY_CRITERIA[ACTIVITY_NONE], 'string');
  for (const activity of ACTIVITY_IDS) {
    assert.equal(typeof ACTIVITY_CRITERIA[activity], 'string');
    for (const intent of INTENTS) {
      const text = SUMMARY_TEMPLATES[activity][intent];
      assert.equal(typeof text, 'string', `${activity}/${intent} has no template`);
      const words = text.trim().split(/\s+/).length;
      assert.ok(words >= 2 && words <= 12, `${activity}/${intent} has ${words} words`);
      assert.doesNotMatch(text,/next step|I will/i);
    }
  }

  const { items, apiCalls, client } = await classify(
    [{
      text: 'I am working on the animation plan.',
      tasks: [{ id: 'task-animation', title: 'Animation', status: 'active' }],
    }],
    {
      worth: 0.9,
      activity: 'animation_design',
      intent: 'active',
      phase: 'implement',
      task: 't1',
    },
  );

  assert.equal(apiCalls, 1);
  assert.equal(client.calls.length, 1);
  const decision = items[0].decision;
  assert.equal(decision.activity.value, 'animation_design');
  assert.equal(decision.activity.confidence, 0.9);
  assert.equal(decision.sentence.id, 'summary:animation_design:active');
  assert.equal(decision.sentence.text, SUMMARY_TEMPLATES.animation_design.active);
  assert.equal(decision.task.id, 'task-animation');
  assert.equal(decision.summaryKey, 'animation_design:active:task-animation');
  assert.equal(decision.source, 'controlled-summary');
  assert.equal(decision.shouldDisplay, true);
  assert.equal(decision.display.sentenceId, 'summary:animation_design:active');
});

test('planned work uses the planned template and is not upgraded to completion', async () => {
  const { items } = await classify(
    [{ text: 'I will implement the settings panel next.' }],
    { worth: 0.9, activity: 'implement', intent: 'planned', phase: 'implement' },
  );

  const decision = items[0].decision;
  assert.equal(decision.intent.value, 'planned');
  assert.equal(decision.sentence.text, SUMMARY_TEMPLATES.implement.planned);
  assert.doesNotMatch(decision.sentence.text, /\b(completed|complete|finished|passed|succeeded)\b/i);
  assert.equal(decision.display.completionClaim, false);
});

test('detail-only paragraphs and an activity of none are never displayed', async () => {
  const detail = [
    'Set the role color to #ff00aa and move the box to left 12px.',
    'Change array index 3 and read the CSS width value.',
  ].join('\n');

  const low = await classify(
    [{ text: detail }],
    { worth: 0.05, activity: 'visual_design', intent: 'active', phase: 'implement' },
  );
  assert.equal(low.items[0].decision.shouldDisplay, false);
  assert.equal(low.items[0].decision.display.shouldShow, false);

  const none = await classify(
    [{ text: detail }],
    { worth: 0.95, activity: ACTIVITY_NONE, intent: 'active', phase: 'other' },
  );
  const decision = none.items[0].decision;
  assert.equal(decision.activity.value, ACTIVITY_NONE);
  assert.equal(decision.sentence, null);
  assert.equal(decision.summaryKey, null);
  assert.equal(decision.shouldDisplay, false);
  assert.equal(decision.display.reason, 'activity_none');
});

test('an activity outside the fixed choices is rejected after strict parsing', async () => {
  const { items, apiCalls, client } = await classify(
    [{ text: 'Some work.' }],
    { worth: 0.9, activity: 'environment', intent: 'active' },
    (response) => {
      response.answers.activity = {
        ...response.answers.activity,
        choice: 'measurement-only',
      };
    },
  );

  assert.equal(apiCalls, 1);
  assert.equal(client.calls.length, 1);
  assert.equal(items[0].decision, undefined);
  assert.equal(items[0].error.code, 'invalid_decision');
  assert.ok(items[0].error instanceof Error);
});

test('four contexts use one root-plus-states call and no sentence question', async () => {
  const contexts = Array.from({ length: 4 }, (_unused, index) => ({
    text: `Paragraph ${index} reports a concrete step.`,
  }));
  const { items, apiCalls, client } = await classify(
    contexts,
    { worth: 0.9, activity: 'environment', intent: 'active', phase: 'understand' },
  );

  assert.equal(apiCalls, 1);
  assert.equal(client.calls.length, 1);
  const payload = client.calls[0].payload;
  assert.deepEqual(Object.keys(payload.states), ['p1', 'p2', 'p3']);
  assert.equal('sentence' in payload.questions, false);
  assert.ok(payload.questions.activity);
  for (const state of Object.values(payload.states)) {
    assert.equal('sentence' in state.questions, false);
    assert.ok(state.questions.activity);
  }
  assert.equal(items.length, 4);
  for (const item of items) {
    assert.equal(item.decision.activity.value, 'environment');
    assert.equal(item.decision.sentence.id, 'summary:environment:active');
    assert.equal(item.decision.summaryKey, 'environment:active:unassigned');
    assert.equal(item.decision.shouldDisplay, true);
  }
});

test('raw sensitive text and implementation details never enter the controlled sentence', async () => {
  const secret = `sk-vsr-${'z'.repeat(43)}`;
  const detail = 'Move the box to left 12px, set the CSS color to #ff00aa, and read index 3.';
  const { items, client } = await classify(
    [{ text: `${detail}\nAPI_KEY=${secret}` }],
    { worth: 0.9, activity: 'implement', intent: 'active', phase: 'implement' },
  );

  const decision = items[0].decision;
  assert.equal(decision.sentence.text, SUMMARY_TEMPLATES.implement.active);
  assert.equal(decision.source, 'controlled-summary');
  for (const forbidden of [secret, 'API_KEY', '12px', '#ff00aa', 'index 3', 'Move the box']) {
    assert.ok(!decision.sentence.text.includes(forbidden));
    assert.ok(!JSON.stringify(decision).includes(forbidden));
  }
  assert.ok(!client.calls[0].payload.state.includes(secret));
});

test('a concrete later milestone can be selected for native translation without an explicit recap heading',async()=>{
  const text='The duplicate updates come from a phase-wide replacement. Keeping one recap per source step preserves the later findings.';
  const {items}=await classify([{text,recentSummaries:['The first plan is to inspect the UI.']}],
    {activity:'implement',intent:'active',update_kind:'milestone',recap:'whole'});
  assert.equal(items[0].decision.updateKind,'milestone');
  assert.equal(items[0].decision.recap,text);
});
