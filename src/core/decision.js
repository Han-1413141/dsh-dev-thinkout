import {
  JEV_MODEL,
  SENTENCE_NONE,
  SIGNIFICANCE_LEVELS,
  TASK_NONE,
} from './questions.js';
import { redactString } from './redact.js';
import { truncateText } from './text.js';

const DEFAULT_WORTH_THRESHOLD = 0.5;
const PROBABILITY_TOLERANCE = 0.02;
const SCORE_TOLERANCE = 0.25;
const ARGMAX_TOLERANCE = 0.005;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeMessage(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return truncateText(redactString(text), 220);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {object}
 */
function failure(code, message, extra = {}) {
  return {
    ok: false,
    error: code,
    message: safeMessage(message),
    errors: [],
    ...extra,
  };
}

/**
 * @param {object[]} errors
 * @param {string} question
 * @param {string} code
 * @param {string} message
 */
function addError(errors, question, code, message) {
  errors.push({ question, code, message: safeMessage(message) });
}

/**
 * Validate a choice answer against its question's criteria.
 * @param {Record<string, unknown>} answer
 * @param {{criteria?: unknown}} spec
 * @param {string} id
 * @param {object[]} errors
 * @returns {object|null}
 */
function parseChoice(answer, spec, id, errors) {
  const criteria = isRecord(spec.criteria) ? spec.criteria : null;
  if (criteria === null || Object.keys(criteria).length < 2) {
    addError(errors, id, 'invalid_question', 'choice criteria must contain at least two options');
    return null;
  }
  const options = Object.keys(criteria);
  const choice = answer.choice;
  if (typeof choice !== 'string' || !Object.hasOwn(criteria, choice)) {
    addError(errors, id, 'invalid_choice', 'choice is not one of the offered options');
    return null;
  }
  if (!isRecord(answer.probabilities)) {
    addError(errors, id, 'invalid_probabilities', 'choice probabilities must be an object');
    return null;
  }
  const probabilities = answer.probabilities;
  const keys = Object.keys(probabilities);
  if (keys.length !== options.length || !options.every((option) => Object.hasOwn(probabilities, option))) {
    addError(errors, id, 'invalid_probabilities', 'choice probabilities must cover exactly the offered options');
    return null;
  }
  let sum = 0;
  let maximum = -Infinity;
  for (const option of options) {
    const probability = probabilities[option];
    if (!isProbability(probability)) {
      addError(errors, id, 'invalid_probabilities', `probability for ${option} is outside [0,1]`);
      return null;
    }
    sum += probability;
    if (probability > maximum) maximum = probability;
  }
  if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
    addError(errors, id, 'invalid_probabilities', 'choice probabilities do not sum to 1');
    return null;
  }
  if (!isProbability(answer.confidence)) {
    addError(errors, id, 'invalid_confidence', 'choice confidence must be a probability');
    return null;
  }
  if (Number(probabilities[choice]) < maximum - ARGMAX_TOLERANCE) {
    addError(errors, id, 'inconsistent_choice', 'choice is not the most probable option');
    return null;
  }
  return {
    type: 'choice',
    value: choice,
    confidence: answer.confidence,
    probabilities: Object.fromEntries(options.map((option) => [option, probabilities[option]])),
  };
}

/**
 * @param {Record<string, unknown>} answer
 * @param {string} id
 * @param {object[]} errors
 * @returns {object|null}
 */
function parseNoul(answer, id, errors) {
  if (!isProbability(answer.noul)) {
    addError(errors, id, 'invalid_noul', 'noul must be a probability');
    return null;
  }
  if (answer.choice !== undefined || answer.score !== undefined || answer.probabilities !== undefined) {
    addError(errors, id, 'invalid_noul', 'noul answer carries fields of another question type');
    return null;
  }
  if (answer.confidence !== undefined && !isProbability(answer.confidence)) {
    addError(errors, id, 'invalid_confidence', 'noul confidence must be a probability when present');
    return null;
  }
  return {
    type: 'noul',
    probability: answer.noul,
    yes: answer.noul,
    no: 1 - answer.noul,
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
  };
}

/**
 * @param {Record<string, unknown>} answer
 * @param {{criteria?: unknown}} spec
 * @param {string} id
 * @param {object[]} errors
 * @returns {object|null}
 */
function parseScore(answer, spec, id, errors) {
  const levels = Array.isArray(spec.criteria) ? spec.criteria : null;
  if (levels === null || levels.length < 2 || levels.length > 10) {
    addError(errors, id, 'invalid_question', 'score criteria must contain 2 to 10 levels');
    return null;
  }
  const levelCount = levels.length;
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)
    || answer.score < 0 || answer.score > levelCount - 1) {
    addError(errors, id, 'invalid_score', 'score is outside the offered levels');
    return null;
  }
  if (!isRecord(answer.probabilities)) {
    addError(errors, id, 'invalid_probabilities', 'score probabilities must be an object');
    return null;
  }
  const probabilities = answer.probabilities;
  const keys = Object.keys(probabilities);
  if (keys.length !== levelCount) {
    addError(errors, id, 'invalid_probabilities', 'score probabilities must cover every level');
    return null;
  }
  let sum = 0;
  let expected = 0;
  for (let level = 0; level < levelCount; level += 1) {
    const key = String(level);
    const probability = probabilities[key];
    if (!isProbability(probability)) {
      addError(errors, id, 'invalid_probabilities', `probability for level ${level} is outside [0,1]`);
      return null;
    }
    sum += probability;
    expected += probability * level;
  }
  if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
    addError(errors, id, 'invalid_probabilities', 'score probabilities do not sum to 1');
    return null;
  }
  if (!isProbability(answer.confidence)) {
    addError(errors, id, 'invalid_confidence', 'score confidence must be a probability');
    return null;
  }
  if (Math.abs(expected - answer.score) > SCORE_TOLERANCE) {
    addError(errors, id, 'inconsistent_score', 'score does not match its expected level');
    return null;
  }
  if (answer.legend !== undefined) {
    if (!isRecord(answer.legend)
      || Object.keys(answer.legend).length !== levelCount
      || !Array.from({ length: levelCount }, (_unused, level) => typeof answer.legend[String(level)] === 'string').every(Boolean)) {
      addError(errors, id, 'invalid_legend', 'score legend must map every level to a string');
      return null;
    }
  }
  const level = Math.max(0, Math.min(levelCount - 1, Math.round(answer.score)));
  return {
    type: 'score',
    score: answer.score,
    level,
    label: String(levels[level] ?? SIGNIFICANCE_LEVELS[level] ?? ''),
    confidence: answer.confidence,
    probabilities: Object.fromEntries(Array.from({ length: levelCount }, (_unused, index) => [String(index), probabilities[String(index)]])),
  };
}

/**
 * Validate a JeV decision response and map it back to local ids.
 *
 * Any malformed answer, error question, missing answer, or model mismatch
 * returns `{ok:false}`. The function never invents a sentence or task title and
 * never throws for malformed JSON-shaped input.
 *
 * @param {unknown} response
 * @param {{model?: string, questions: Record<string, object>, meta?: object}} context
 * @returns {object}
 */
export function parseDecision(response, context) {
  try {
    if (!isRecord(context) || !isRecord(context.questions) || Object.keys(context.questions).length === 0) {
      return failure('invalid_context', 'context.questions must be a non-empty question map');
    }
    const expectedModel = typeof context.model === 'string' && context.model !== '' ? context.model : JEV_MODEL;
    if (!isRecord(response)) {
      return failure('invalid_response', 'response is not an object', { model: null });
    }
    const errors = [];
    const model = typeof response.model === 'string' ? response.model : null;
    if (model === null) {
      addError(errors, 'response', 'missing_model', 'response.model is required');
    } else if (model !== expectedModel) {
      addError(errors, 'response', 'model_mismatch', `expected model ${expectedModel}`);
    }

    if (response.error !== undefined) {
      const apiError = isRecord(response.error) ? response.error : { message: response.error };
      addError(
        errors,
        'response',
        'api_error',
        `${apiError.code ?? 'error'}: ${apiError.message ?? 'JeV request failed'}`,
      );
    }

    if (!isRecord(response.answers)) {
      addError(errors, 'response', 'invalid_answers', 'response.answers must be an object');
      return {
        ok: false,
        error: 'invalid_response',
        message: 'response.answers is missing or invalid',
        model,
        errors,
      };
    }

    const answers = response.answers;
    const expectedIds = Object.keys(context.questions);
    for (const id of Object.keys(answers)) {
      if (!Object.hasOwn(context.questions, id)) {
        addError(errors, id, 'unknown_answer', 'answer id was not asked');
      }
    }

    /** @type {Record<string, object>} */
    const validated = {};
    for (const id of expectedIds) {
      const spec = context.questions[id];
      if (!isRecord(spec) || typeof spec.type !== 'string') {
        addError(errors, id, 'invalid_question', 'question specification is invalid');
        continue;
      }
      if (!Object.hasOwn(answers, id)) {
        addError(errors, id, 'missing_answer', 'answer is missing');
        continue;
      }
      const answer = answers[id];
      if (!isRecord(answer)) {
        addError(errors, id, 'invalid_answer', 'answer is not an object');
        continue;
      }
      if (answer.error !== undefined) {
        addError(errors, id, 'question_error', `${answer.code ?? answer.error}: ${answer.message ?? 'question failed'}`);
        continue;
      }
      if (answer.type !== spec.type) {
        addError(errors, id, 'wrong_answer_type', `expected ${spec.type}`);
        continue;
      }
      let parsed = null;
      if (spec.type === 'choice') parsed = parseChoice(answer, spec, id, errors);
      else if (spec.type === 'noul') parsed = parseNoul(answer, id, errors);
      else if (spec.type === 'score') parsed = parseScore(answer, spec, id, errors);
      else addError(errors, id, 'invalid_question', `unsupported question type ${spec.type}`);
      if (parsed !== null) validated[id] = parsed;
    }

    if (errors.length > 0) {
      return {
        ok: false,
        error: errors.some((entry) => entry.code === 'question_error') ? 'question_error' : 'invalid_response',
        message: 'JeV response rejected; state was not updated',
        model,
        errors,
      };
    }

    const meta = isRecord(context.meta) ? context.meta : {};
    const phase = validated.phase;
    const intent = validated.intent;
    const relation = validated.relation;
    if (!phase || !intent || !relation) {
      return failure('invalid_context', 'phase, intent, and relation questions are required', { model, errors });
    }

    let task = null;
    if (validated.task) {
      const option = validated.task.value;
      if (option !== TASK_NONE) {
        const rows = Array.isArray(meta.tasks) ? meta.tasks : [];
        const row = rows.find((entry) => isRecord(entry) && entry.option === option);
        if (!row || typeof row.title !== 'string') {
          return failure('invalid_context', `task option ${option} has no local mapping`, { model, errors });
        }
        task = {
          ...validated.task,
          option,
          id: typeof row.id === 'string' && row.id !== '' ? row.id : null,
          title: row.title,
          status: typeof row.status === 'string' ? row.status : 'unknown',
        };
      }
    }

    let sentence = null;
    if (validated.sentence) {
      const option = validated.sentence.value;
      if (option !== SENTENCE_NONE) {
        const rows = Array.isArray(meta.candidates) ? meta.candidates : [];
        const row = rows.find((entry) => isRecord(entry) && entry.id === option);
        if (!row || typeof row.text !== 'string') {
          return failure('invalid_context', `sentence option ${option} has no local mapping`, { model, errors });
        }
        sentence = {
          id: option,
          text: row.text,
          confidence: validated.sentence.confidence,
        };
      }
    } else if (Array.isArray(meta.candidates) && meta.candidates.length === 1) {
      sentence = { id:meta.candidates[0].id, text:meta.candidates[0].text, confidence:1 };
    }

    const threshold = isRecord(context.thresholds) && isProbability(context.thresholds.worth)
      ? context.thresholds.worth
      : DEFAULT_WORTH_THRESHOLD;
    const worth = validated.worth;
    if (!worth) {
      return failure('invalid_context', 'worth question is required', { model, errors });
    }
    const significance = validated.significance;
    if (!significance) {
      return failure('invalid_context', 'significance question is required', { model, errors });
    }

    const discreteConfidences = [phase.confidence, intent.confidence, relation.confidence];
    if (task) discreteConfidences.push(task.confidence);
    if (validated.sentence) discreteConfidences.push(validated.sentence.confidence);
    discreteConfidences.push(Math.max(worth.probability, 1 - worth.probability));
    const confidence = Math.min(...discreteConfidences);
    const shouldDisplay = worth.probability >= threshold;

    return {
      ok: true,
      model,
      worth: {
        probability: worth.probability,
        yes: worth.yes,
        no: worth.no,
        threshold,
        shouldDisplay,
      },
      significance: {
        score: significance.score,
        level: significance.level,
        label: significance.label,
        confidence: significance.confidence,
        probabilities: significance.probabilities,
      },
      phase: { value: phase.value, confidence: phase.confidence, probabilities: phase.probabilities },
      intent: { value: intent.value, confidence: intent.confidence, probabilities: intent.probabilities },
      task,
      relation: {
        value: relation.value,
        confidence: relation.confidence,
        probabilities: relation.probabilities,
        previousNodeId: isRecord(meta.previousNode) && typeof meta.previousNode.id === 'string'
          ? meta.previousNode.id
          : null,
      },
      sentence,
      sentenceId: sentence?.id ?? null,
      taskId: task?.id ?? null,
      confidence,
      shouldDisplay,
      display: {
        shouldShow: shouldDisplay,
        phase: phase.value,
        intent: intent.value,
        taskId: task?.id ?? null,
        taskTitle: task?.title ?? null,
        relation: relation.value,
        sentenceId: sentence?.id ?? null,
        completionClaim: intent.value === 'reported_done',
        verifiedCompletion: false,
        reason: shouldDisplay ? 'worth_showing' : 'worth_below_threshold',
      },
      thresholds: { worth: threshold },
    };
  } catch (error) {
    return failure('invalid_response', error instanceof Error ? error.message : String(error));
  }
}
