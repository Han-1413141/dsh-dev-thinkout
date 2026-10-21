import { INTENTS } from './questions.js';

/**
 * Fixed high-level activities. JeV only selects an id; this module owns the
 * display text so no excerpt, code, or model-written sentence can become the
 * user-visible summary.
 */
export const ACTIVITY_NONE = 'none';

export const ACTIVITIES = Object.freeze([
  Object.freeze({
    id: 'environment',
    title: 'Confirm the working environment',
    description: 'Check tools, access, workspace setup, or required conditions before the task can start.',
  }),
  Object.freeze({
    id: 'research',
    title: 'Review materials',
    description: 'Inspect source, documentation, references, APIs, or existing behavior to gather facts.',
  }),
  Object.freeze({
    id: 'plan',
    title: 'Form a plan',
    description: 'Choose an approach and define the ordered steps before execution.',
  }),
  Object.freeze({
    id: 'visual_design',
    title: 'Design the visual presentation',
    description: 'Plan or produce the overall visual composition of an illustration, document or interface. Isolated colors, coordinates or shape dimensions are not a task-level update.',
  }),
  Object.freeze({
    id: 'animation_design',
    title: 'Design animation',
    description: 'Work on motion relationships, timing, transitions, or the overall presentation of animation.',
  }),
  Object.freeze({
    id: 'produce_files',
    title: 'Produce deliverable files',
    description: 'Create documents, assets, examples, or other requested files.',
  }),
  Object.freeze({
    id: 'implement',
    title: 'Implement functionality',
    description: 'Write or change code and behavior to deliver the requested feature.',
  }),
  Object.freeze({
    id: 'integrate',
    title: 'Integrate parts',
    description: 'Connect modules, components, data, or workflows and resolve their boundaries.',
  }),
  Object.freeze({
    id: 'verify',
    title: 'Verify the work',
    description: 'Run checks or tests, review evidence, and establish whether a result holds.',
  }),
  Object.freeze({
    id: 'fix',
    title: 'Repair a problem',
    description: 'Diagnose a failure or defect and apply a targeted correction.',
  }),
  Object.freeze({
    id: 'document',
    title: 'Organize explanation',
    description: 'Write or refine usage notes, implementation notes, or handoff documentation.',
  }),
  Object.freeze({
    id: 'deliver',
    title: 'Deliver the result',
    description: 'Present or hand off the finished work with the information needed to use it.',
  }),
]);

export const ACTIVITY_IDS = Object.freeze(ACTIVITIES.map((activity) => activity.id));
export const ACTIVITY_LABELS = Object.freeze({
  environment:'确认工作环境',research:'查阅资料',plan:'梳理任务方案',visual_design:'设计画面',
  animation_design:'设计动画',produce_files:'制作交付文件',implement:'实现功能',integrate:'整合各个部分',
  verify:'检查结果',fix:'排查并修复问题',document:'整理说明',deliver:'整理交付结果',
});
export function fallbackStatus(activity,intent) {
  const label=ACTIVITY_LABELS[activity]??'处理任务';
  if(intent==='planned')return {
    environment:'正在梳理工作环境要求',research:'正在规划资料查阅',plan:'正在梳理任务方案',
    visual_design:'正在规划画面结构',animation_design:'正在规划动画方案',produce_files:'正在规划交付文件',
    implement:'正在规划实现方案',integrate:'正在规划整合步骤',verify:'正在制定检查方案',
    fix:'正在制定修复方案',document:'正在规划说明内容',deliver:'正在整理交付安排',
  }[activity]??'正在梳理任务方案';
  if(intent==='reported_done')return `已报告完成：${label}`;
  if(intent==='blocked')return `${label}遇到阻碍`;
  return `正在${label}`;
}
export const ACTIVITY_PHASES = Object.freeze({
  environment:'understand',research:'research',plan:'plan',visual_design:'implement',
  animation_design:'implement',produce_files:'implement',implement:'implement',integrate:'implement',
  verify:'verify',fix:'debug',document:'deliver',deliver:'deliver',
});

/**
 * Choice criteria sent to JeV. The list is fixed; `none` keeps detail-only
 * paragraphs from being forced into a high-level activity.
 */
export const ACTIVITY_CRITERIA = Object.freeze({
  ...Object.fromEntries(ACTIVITIES.map((activity) => [
    activity.id,
    `${activity.title}: ${activity.description}`,
  ])),
  [ACTIVITY_NONE]: 'No clear high-level activity: detail-only text, measurements, colors, indexes, code fragments, parameters, rhetorical questions, or repetition.',
});

/**
 * Controlled English templates, one per activity and intent. They describe the
 * reported stage only. They never add a test result, delivery promise, cause of
 * a blocker, or other fact that the classifier was not asked to establish.
 *
 * @type {Readonly<Record<string, Readonly<Record<'planned'|'active'|'reported_done'|'blocked', string>>>>}
 */
const ACTIVITY_OBJECTS = Object.freeze({
  environment:'the working environment', research:'source materials', plan:'the task approach',
  visual_design:'the visual composition', animation_design:'the animation', produce_files:'the deliverable files',
  implement:'the implementation', integrate:'the integration', verify:'the verification',
  fix:'the repair', document:'the documentation', deliver:'the handoff',
});
const ACTIVE_ACTIONS = {environment:'Checking',research:'Reviewing',plan:'Planning',visual_design:'Designing',
  animation_design:'Designing',produce_files:'Creating',implement:'Developing',integrate:'Connecting',
  verify:'Checking',fix:'Investigating',document:'Writing',deliver:'Preparing'};
export const SUMMARY_TEMPLATES = Object.freeze(Object.fromEntries(ACTIVITY_IDS.map(id=>[id,Object.freeze({
  planned:'Planning '+ACTIVITY_OBJECTS[id],
  active:ACTIVE_ACTIONS[id]+' '+ACTIVITY_OBJECTS[id],
  reported_done:'Reported complete: '+ACTIVITY_OBJECTS[id],
  blocked:'An obstacle is blocking '+ACTIVITY_OBJECTS[id],
})])));

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isActivityId(value) {
  return typeof value === 'string' && (value === ACTIVITY_NONE || ACTIVITY_IDS.includes(value));
}

/**
 * Return the controlled template for an activity/intent pair. `null` means the
 * pair is not covered; callers must not synthesize text.
 *
 * @param {string} activity
 * @param {string} intent
 * @returns {string|null}
 */
export function summaryTemplateFor(activity, intent) {
  if (!ACTIVITY_IDS.includes(activity) || !INTENTS.includes(intent)) return null;
  const templates = SUMMARY_TEMPLATES[activity];
  return typeof templates?.[intent] === 'string' ? templates[intent] : null;
}

/**
 * Build the local sentence and aggregation key. The activity id, intent, and
 * task id are all local values; no model-written display text is accepted.
 *
 * @param {string} activity
 * @param {string} intent
 * @param {string|null} [taskId]
 * @returns {{sentence: {id: string, text: string}, summaryKey: string}|null}
 */
export function buildSummary(activity, intent, taskId = null) {
  const text = summaryTemplateFor(activity, intent);
  if (text === null) return null;
  const keyTask = typeof taskId === 'string' && taskId.trim() !== '' ? taskId.trim() : 'unassigned';
  return {
    sentence: { id: `summary:${activity}:${intent}`, text },
    summaryKey: `${activity}:${intent}:${keyTask}`,
  };
}
