import { buildQuestions, buildFocusQuestions } from './core/questions.js';
import { parseDecision } from './core/decision.js';

/** Keep labels attached to exactly the text the user will see. */
export async function classifyProgress(client, context, signal) {
  const decide = async request => {
    const { data } = await client.decide({
      model: request.model, state: request.state, questions: request.questions,
    }, signal);
    const result = parseDecision(data, request);
    if (!result.ok) throw Object.assign(new Error('invalid_decision'), { code: 'invalid_decision' });
    return result;
  };
  const request = buildQuestions(context);
  let decision = await decide(request);
  let calls = 1;
  if (decision.sentence && JSON.parse(request.state).excerpt.trim().replace(/\s+/g,' ') !== decision.sentence.text.trim()) {
    // Selection and classification are independent model questions. A second
    // pass with the selected sentence as its target prevents labels for task A
    // being attached to a displayed sentence about task B. Immediate neighbors
    // are included only to resolve references and following corrections; the
    // excerpt field stays exactly the selected sentence.
    const focus = buildFocusQuestions(context, decision.sentence.text);
    decision = await decide(focus);
    calls++;
  }
  return { decision, calls };
}
