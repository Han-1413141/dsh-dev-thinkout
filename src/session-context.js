import { redactString } from './core/redact.js';

/** Only human requests are goals. DSH also uses user/message for runtime notices. */
export function userGoal(event) {
  if (event?.type !== 'user/message') return null;
  const message = event.data?.message ?? event.data;
  if (message?.source?.kind !== 'user') return null;
  const text = (message.content || []).filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
  return redactString(text).replace(/\s+/g, ' ').trim().slice(0, 800) || null;
}

/** Read existing events; never append a message or alter the model's surface. */
export function primeSessionContext(pipeline, session) {
  let goal, todos;
  const log = session?.log;
  if (!Array.isArray(log)) return;
  for (let i = log.length - 1, seen = 0; i >= 0 && seen < 4096; i--, seen++) {
    const event = log[i];
    if (!goal && userGoal(event)) goal = event;
    if (!todos && event.type === 'todo/write') todos = event;
    if (goal && todos) break;
  }
  if (goal) pipeline.onEvent(goal);
  if (todos) pipeline.onEvent(todos);
}
