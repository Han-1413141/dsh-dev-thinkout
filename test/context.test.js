import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQuestions,
  buildFocusQuestions,
  splitCandidateSentences,
  MAX_ACTIVE_TOOLS,
  MAX_CANDIDATES,
  MAX_PREVIOUS_EXCERPT_CHARS,
  MAX_STATE_CHARS,
  MAX_TASK_GOAL_CHARS,
} from '../src/core/questions.js';
import { parseDecision } from '../src/core/decision.js';
import { classifyProgress } from '../src/classify.js';
import { classifyBatch } from '../src/batch-classify.js';

/**
 * Build a strictly valid fake JeV response. This is only a test double for the
 * request/response contract; it does not demonstrate real model quality.
 */
function answerFor(request, choices = {}) {
  const answers = {};
  for (const [id, spec] of Object.entries(request.questions)) {
    if (spec.type === 'noul') {
      answers[id] = { type: 'noul', noul: choices[id] ?? 0.9 };
      continue;
    }
    if (spec.type === 'score') {
      const score = choices[id] ?? 2;
      answers[id] = {
        type: 'score',
        score,
        confidence: 1,
        probabilities: Object.fromEntries(
          spec.criteria.map((_label, index) => [String(index), index === score ? 1 : 0]),
        ),
      };
      continue;
    }
    const options = Object.keys(spec.criteria);
    const fallback = {
      phase: 'implement',
      intent: 'active',
      relation: 'unrelated',
      task: 'none',
      sentence: 's1',
    }[id];
    const choice = choices[id] ?? (options.includes(fallback) ? fallback : options[0]);
    answers[id] = {
      type: 'choice',
      choice,
      confidence: 1,
      probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0])),
    };
  }
  return { model: request.model, answers };
}

function candidateId(plan, pattern) {
  const row = plan.meta.candidates.find((candidate) => pattern.test(candidate.text));
  assert.ok(row, `expected a candidate matching ${pattern}`);
  return row.id;
}

function requestList(payload) {
  return [
    { model: payload.model, state: payload.state, questions: payload.questions },
    ...Object.values(payload.states ?? {}).map((state) => ({ model: payload.model, ...state })),
  ];
}

test('a concrete first plan is displayable before any completed work (simulated decision)', () => {
  const context = {
    segment: 'We need to create an SVG animation of a pelican riding a bicycle. Need figure workspace. '
      + 'Simple single-file deliverable: an animated SVG. Should create file, verify, present. Use tools.',
    taskGoal: '画一个鹈鹕骑车 SVG 动画',
    currentStep: { turn: 1, step: 1, firstUpdate: true, activeTools: [] },
  };
  const plan = buildQuestions(context);
  const state = JSON.parse(plan.state);

  assert.equal(state.taskGoal, context.taskGoal);
  assert.equal(state.currentStep.turn, 1);
  assert.equal(state.currentStep.step, 1);
  assert.equal(state.currentStep.firstUpdate, true);
  assert.deepEqual(state.currentStep.activeTools, []);
  assert.match(plan.questions.worth.instructions, /concrete first plan/i);
  assert.match(plan.questions.worth.instructions, /restatement of taskGoal/i);

  const planId = candidateId(plan, /single-file|Should create file/i);
  const first = parseDecision(answerFor(plan, {
    worth: 0.92,
    sentence: planId,
    phase: 'plan',
    intent: 'planned',
    relation: 'unrelated',
    significance: 3,
  }), plan);

  assert.equal(first.ok, true);
  assert.equal(first.shouldDisplay, true);
  assert.equal(first.phase.value, 'plan');
  assert.equal(first.intent.value, 'planned');
  assert.equal(first.display.completionClaim, false);
  assert.match(first.sentence.text, /single-file|create file/i);

  // A low-worth decision is still suppressed by the threshold. This checks the
  // decision boundary, not whether a real JeV run would score a restatement so.
  const suppressed = parseDecision(answerFor(plan, {
    worth: 0.2,
    sentence: planId,
    phase: 'understand',
    intent: 'planned',
    relation: 'unrelated',
  }), plan);
  assert.equal(suppressed.ok, true);
  assert.equal(suppressed.shouldDisplay, false);

  // The concrete first-plan example, including a Chinese heading on its own
  // line: the heading is joined forward instead of becoming a bare candidate.
  const chinese = buildQuestions({
    segment: '计划：\n先确认工作目录，再制作单文件 SVG 动画。',
    taskGoal: '制作鹈鹕骑车 SVG 动画',
    currentStep: { turn: 1, step: 1, firstUpdate: true },
  });
  assert.equal(chinese.meta.candidates.length, 1);
  const chineseDecision = parseDecision(answerFor(chinese, {
    worth: 0.9,
    phase: 'plan',
    intent: 'planned',
    relation: 'unrelated',
  }), chinese);
  assert.equal(chineseDecision.shouldDisplay, true);
  assert.equal(chineseDecision.sentence.text, '计划：先确认工作目录，再制作单文件 SVG 动画。');
});

test('taskGoal, currentStep, and previousExcerpt are bounded, redacted, and JeV-only state', () => {
  const secret = `sk-vsr-${'a'.repeat(43)}`;
  const plan = buildQuestions({
    segment: 'Implement the parser.',
    taskGoal: `${secret} ${'goal '.repeat(300)}`,
    currentStep: {
      turn: 3,
      step: 9,
      firstUpdate: false,
      activeTools: Array.from({ length: 10 }, (_unused, index) => ({
        name: `tool-${index}`,
        object: `${secret}-${index}`,
      })),
    },
    previousExcerpt: `${secret} ${'previous '.repeat(200)}`,
  });
  const state = JSON.parse(plan.state);

  assert.equal(state.taskGoal.length <= MAX_TASK_GOAL_CHARS, true);
  assert.equal(state.previousExcerpt.length <= MAX_PREVIOUS_EXCERPT_CHARS, true);
  assert.equal(state.currentStep.turn, 3);
  assert.equal(state.currentStep.step, 9);
  assert.equal(state.currentStep.firstUpdate, false);
  assert.equal(state.currentStep.activeTools.length <= MAX_ACTIVE_TOOLS, true);
  assert.ok(plan.state.length <= MAX_STATE_CHARS);
  assert.equal(JSON.stringify(plan).includes(secret), false);
  assert.equal(plan.meta.context.taskGoalChars <= MAX_TASK_GOAL_CHARS, true);
  assert.equal(plan.meta.context.previousExcerptChars <= MAX_PREVIOUS_EXCERPT_CHARS, true);
  assert.match(plan.questions.intent.instructions, /do not borrow a completion or failure claim from background/);

  // A previous paragraph sliced at a UTF-16 boundary must not leave a lone
  // surrogate in the JSON state.
  const sanitized = buildQuestions({
    segment: 'Implement the parser.',
    previousExcerpt: '\ud83d😀 done',
  });
  assert.equal(JSON.parse(sanitized.state).previousExcerpt, '😀 done');
});

test('a following correction is kept with its sentence and available as focus context', () => {
  const negation = 'Could be a bug. Actually, this is expected.';
  assert.deepEqual(splitCandidateSentences(negation), [negation]);

  const plan = buildQuestions({ segment: negation });
  assert.equal(plan.meta.candidates.length, 1);
  assert.equal(plan.meta.candidates[0].text, negation);
  const decision = parseDecision(answerFor(plan, {
    worth: 0.8,
    phase: 'research',
    intent: 'active',
    relation: 'unrelated',
  }), plan);
  assert.equal(decision.sentence.text, negation);
  assert.equal(decision.display.completionClaim, false);

  const source = 'The parser looks broken. Retrying with the stored fixture confirms this is expected.';
  const focus = buildFocusQuestions({
    segment: source,
    taskGoal: 'Fix the parser',
    currentStep: { turn: 1, step: 2, firstUpdate: false },
  }, 'The parser looks broken.');
  const focusState = JSON.parse(focus.state);
  assert.equal(focusState.excerpt, 'The parser looks broken.');
  assert.match(focusState.focusContext.after, /confirms this is expected/i);
  assert.doesNotMatch(focusState.excerpt, /confirms/i);

  // A first-sentence focus has no immediate before-neighbor, so the adjacent
  // previous paragraph remains available for cross-paragraph references.
  const noBefore = buildFocusQuestions({
    segment: 'Let me check the working directory.',
    previousExcerpt: 'The user asked for an SVG animation.',
  }, 'Let me check the working directory.');
  const noBeforeState = JSON.parse(noBefore.state);
  assert.equal(noBeforeState.previousExcerpt, 'The user asked for an SVG animation.');
  assert.equal('focusContext' in noBeforeState, false);
});

test('second pass keeps the selected sentence as the label target despite a completed neighbor', async () => {
  const requests = [];
  const client = {
    decide: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        const selected = Object.entries(request.questions.sentence.criteria)
          .find(([id, text]) => id.startsWith('s') && /I will run integration checks/.test(text))?.[0];
        assert.ok(selected, 'selected sentence must be a real candidate');
        return {
          data: answerFor(request, {
            sentence: selected,
            phase: 'implement',
            intent: 'reported_done',
            relation: 'continue',
            worth: 0.9,
          }),
        };
      }
      return {
        data: answerFor(request, {
          phase: 'verify',
          intent: 'planned',
          relation: 'next',
          worth: 0.9,
        }),
      };
    },
  };

  const { decision, calls } = await classifyProgress(client, {
    segment: 'The parser is implemented. I will run integration checks next.',
    taskGoal: 'Fix the parser and verify it',
    currentStep: { turn: 2, step: 4, firstUpdate: false, activeTools: ['pwsh'] },
    previousExcerpt: 'The parser is implemented.',
  });

  assert.equal(calls, 2);
  const focusState = JSON.parse(requests[1].state);
  assert.equal(focusState.excerpt, 'I will run integration checks next.');
  assert.match(focusState.previousExcerpt, /The parser is implemented/);
  assert.equal('focusContext' in focusState, false);
  assert.match(requests[1].questions.intent.instructions, /do not borrow a completion or failure claim from background/);
  assert.equal(decision.phase.value, 'verify');
  assert.equal(decision.intent.value, 'planned');
  assert.equal(decision.shouldDisplay, true);
  assert.equal(decision.display.completionClaim, false);
  assert.equal(decision.sentence.text, 'I will run integration checks next.');
});

test('focus requests stay in one batch and preserve source order', async () => {
  const payloads = [];
  const client = {
    decide: async (payload) => {
      payloads.push(payload);
      const requests = requestList(payload);
      if (payloads.length === 1) {
        const answers = requests.map((request) => answerFor(request, {
          sentence: 's2',
          phase: 'implement',
          intent: 'reported_done',
          relation: 'unrelated',
          worth: 0.9,
        }));
        return {
          data: {
            model: payload.model,
            answers: answers[0].answers,
            states: { p1: answers[1] },
          },
        };
      }
      const answers = requests.map((request) => answerFor(request, {
        phase: 'verify',
        intent: 'planned',
        relation: 'next',
        worth: 0.9,
      }));
      return {
        data: {
          model: payload.model,
          answers: answers[0].answers,
          states: { p1: answers[1] },
        },
      };
    },
  };

  const result = await classifyBatch(client, [
    {
      segment: 'The parser is implemented. I will run checks.',
      taskGoal: 'Fix the parser',
      previousExcerpt: 'Earlier I read the parser.',
    },
    {
      segment: 'The build fails. The fixture is stale.',
      taskGoal: 'Fix the build',
      previousExcerpt: 'Earlier I read the build.',
    },
  ]);

  assert.equal(result.apiCalls, 2);
  assert.equal(payloads.length, 2);
  assert.equal(Object.keys(payloads[0].states).length, 1);
  assert.equal(Object.keys(payloads[1].states).length, 1);
  assert.equal(result.items[0].decision.phase.value, 'verify');
  assert.equal(result.items[1].decision.phase.value, 'verify');
  assert.equal(result.items[0].decision.intent.value, 'planned');
  assert.equal(result.items[1].decision.intent.value, 'planned');

  const firstFocus = JSON.parse(payloads[1].state);
  const secondFocus = JSON.parse(payloads[1].states.p1.state);
  assert.equal(firstFocus.excerpt, 'I will run checks.');
  assert.equal(secondFocus.excerpt, 'The fixture is stale.');
  assert.match(firstFocus.focusContext.before, /parser is implemented/);
  assert.match(secondFocus.focusContext.before, /build fails/);
  assert.equal(firstFocus.taskGoal, 'Fix the parser');
  assert.equal(firstFocus.previousExcerpt, 'Earlier I read the parser.');
});

test('new context fields never push state beyond the cap', () => {
  const plan = buildQuestions({
    segment: 'Implement module. '.repeat(500),
    taskGoal: 'goal '.repeat(400),
    previousExcerpt: 'previous '.repeat(300),
    currentStep: {
      turn: 7,
      step: 21,
      firstUpdate: false,
      activeTools: Array.from({ length: 10 }, (_unused, index) => `tool-${index}`),
    },
    tasks: Array.from({ length: 20 }, (_unused, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      status: 'active',
    })),
    toolEvidence: Array.from({ length: 10 }, (_unused, index) => ({
      name: 'pwsh',
      ok: true,
      summary: `evidence ${index}`,
    })),
    recentSummaries: Array.from({ length: 5 }, (_unused, index) => `summary ${index}`),
  });

  assert.ok(plan.state.length <= MAX_STATE_CHARS);
  assert.equal(plan.meta.stateTruncated, true);
  const state = JSON.parse(plan.state);
  assert.equal(state.excerpt.length <= 4000, true);
  assert.equal(plan.meta.candidates.length <= MAX_CANDIDATES, true);

  // The JSON cap is measured in UTF-16 code units, so an all-astral excerpt
  // needs the final guard as well.
  const astral = buildQuestions({
    segment: '😀'.repeat(4000),
    taskGoal: 'goal',
    previousExcerpt: 'previous',
  });
  assert.ok(astral.state.length <= MAX_STATE_CHARS);
  assert.notEqual(JSON.parse(astral.state).excerpt, '');
});
