import { progressIcon } from './icons.js';

/**
 * UI-only JeV progress messages.
 *
 * This module never writes to the host session or model context. It projects
 * the read-only `/api/jev-progress/state` response into plain chat-like DOM
 * siblings, using the public DSH 0.2.1-rc.2 chat flow selectors. The pure
 * projection, merge, and grouping functions stay independent from the DOM so
 * they can be tested under Node.
 */

export const JEV_CHAT_LABEL = 'j';
export const JEV_CHAT_MAX_MESSAGES = 200;
const JEV_CHAT_MAX_TEXT = 4000;
const JEV_CHAT_TURN_FIELDS = ['turn', 'turnId', 'turnSeq', 'turnIndex', 'turnKey'];
const JEV_CHAT_STEP_FIELDS = ['step', 'stepIndex', 'stepId', 'assistantStep', 'stepSeq'];

/** Convert a scalar or small key object into a stable display key. */
function chatScalar(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? null : text.slice(0, 120);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value !== null && typeof value === 'object') {
    for (const key of ['id', 'key', 'seq', 'index', 'number']) {
      if (value[key] === undefined) continue;
      const inner = chatScalar(value[key]);
      if (inner !== null) return inner;
    }
  }
  return null;
}

function chatField(object, names) {
  if (object === null || typeof object !== 'object') return null;
  for (const name of names) {
    const key = chatScalar(object[name]);
    if (key !== null) return key;
  }
  return null;
}

function chatNodeTurn(node) {
  const direct = chatField(node, JEV_CHAT_TURN_FIELDS);
  if (direct !== null) return direct;
  return chatField(node?.location, ['turn', 'turnId', 'turnSeq']);
}

function chatNodeStep(node) {
  const direct = chatField(node, JEV_CHAT_STEP_FIELDS);
  if (direct !== null) return direct;
  return chatField(node?.location, ['step', 'stepIndex', 'stepId']);
}

function chatHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function chatMessageId(node, index, text) {
  const explicit = chatField(node, ['id', 'nodeId']);
  return explicit ?? `node:${index}:${chatHash(text)}`;
}

function chatTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function chatStateRevision(state) {
  const graphTime = chatTime(state?.graph?.lastUpdatedAt);
  return graphTime ?? chatTime(state?.lastUpdatedAt);
}

function emptyProjection(sessionId) {
  return {
    enabled: false,
    configured: false,
    active: false,
    sessionId,
    stateSessionId: null,
    hasState: false,
    mismatch: false,
    revision: null,
    messages: [],
  };
}

/**
 * Unwrap either the RPC envelope or its already-unwrapped `value`.
 * A failed envelope is treated as no data.
 */
export function unwrapProgressValue(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  if (payload.ok === false) return null;
  if (payload.ok === true) {
    return payload.value !== null && typeof payload.value === 'object' ? payload.value : null;
  }
  return payload;
}

/**
 * Read-only projection of the filtered progress graph. Only `node.text` is
 * copied into the message body; tool evidence, translation failures, issue
 * text, stats, and raw reasoning never enter this shape.
 *
 * @param {unknown} payload RPC envelope or `{enabled,configured,state}` value.
 * @param {{sessionId?: string}} [options]
 * @returns {object}
 */
export function projectProgress(payload, { sessionId = '' } = {}) {
  const wantedSession = typeof sessionId === 'string' ? sessionId : '';
  const value = unwrapProgressValue(payload);
  if (value === null) return emptyProjection(wantedSession);

  const enabled = value.enabled !== false;
  const configured = value.configured !== false;
  const state = value.state !== null && typeof value.state === 'object' ? value.state : null;
  const stateSessionId = chatScalar(state?.sessionId);
  const mismatch = Boolean(wantedSession && stateSessionId && stateSessionId !== wantedSession);
  const result = {
    enabled,
    configured,
    active: enabled && configured && !mismatch,
    sessionId: wantedSession || stateSessionId || '',
    stateSessionId,
    hasState: state !== null,
    mismatch,
    revision: chatStateRevision(state),
    authoritative: Array.isArray(state?.messages),
    presentation: state?.presentation,
    summaryAppearance:(state?.summaryAppearance??value.summaryAppearance)==='tagged'?'tagged':'plain',
    appearance:['orbit','whale','native','none'].includes(state?.appearance??value.appearance)?state?.appearance??value.appearance:'whale',
    messages: [],
  };
  if (!result.active || state === null) return result;

  // Messages retain every displayed update even when graph stages merge.
  const nodes = Array.isArray(state.messages) ? state.messages : state.graph?.nodes;
  if (!Array.isArray(nodes)) return result;
  const latestProgress=[...nodes].reverse().find(node=>(node.kind==='progress'||!node.kind)&&!node.cancelled);

  const positions = new Map();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === null || typeof node !== 'object') continue;
    const rawText = typeof node.text === 'string' ? node.text.replace(/\r\n?/g, '\n').trim() : '';
    if (rawText === '') continue;
    const text = rawText.slice(0, JEV_CHAT_MAX_TEXT);
    const id = chatMessageId(node, index, text);
    const turn = chatNodeTurn(node);
    const step = chatNodeStep(node);
    const message = {
      id,
      kind:['task_summary','plan_summary','stage_summary'].includes(node.kind)?node.kind:'progress',
      sessionId: result.sessionId,
      turn,
      step,
      groupKey: turn === null ? 'tail' : `turn:${turn}`,
      text,
      canceled: node.cancelled === true || node.canceled === true,
      phase: typeof node.phase === 'string' ? node.phase.slice(0, 32) : '',
      intent: typeof node.intent === 'string' ? node.intent.slice(0, 32) : '',
      time: chatTime(node.at) ?? chatTime(node.lastAt) ?? chatTime(node.firstAt),
      sourceAt:chatTime(node.sourceAt),sourceOffset:node.sourceOffset,blockIndex:node.blockIndex,
      appearance:result.appearance,summaryAppearance:result.summaryAppearance,
      animate:state.running===true&&node===latestProgress&&!node.cancelled&&
        (state.turn==null||String(node.turn)===String(state.turn))&&
        (state.goalSeq==null||node.goalSeq===state.goalSeq)&&['active','planned'].includes(node.intent),
    };
    const duplicate = positions.get(id);
    if (duplicate === undefined) {
      positions.set(id, result.messages.length);
      result.messages.push(message);
    } else {
      // A merged/continued node keeps its original position, latest text wins.
      result.messages[duplicate] = message;
    }
  }
  return result;
}

/** Numeric turn label, or '' for opaque host ids. */
export function progressTurnLabel(turn) {
  if (turn === null || turn === undefined) return '';
  const text = String(turn);
  const number = /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(number) ? `第 ${number} 轮` : '';
}

/** Numeric step label, or '' for opaque host ids. */
export function progressStepLabel(step) {
  if (step === null || step === undefined) return '';
  const text = String(step);
  const number = /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(number) ? `第 ${number} 步` : '';
}

function sameProgressMessage(left, right) {
  return left.id === right.id &&
    left.kind === right.kind &&
    left.sessionId === right.sessionId &&
    left.text === right.text &&
    left.turn === right.turn &&
    left.step === right.step &&
    left.canceled === right.canceled &&
    left.phase === right.phase &&
    left.intent === right.intent &&
    left.sourceOffset === right.sourceOffset &&
    left.blockIndex === right.blockIndex &&
    left.appearance === right.appearance &&
    left.summaryAppearance === right.summaryAppearance &&
    left.animate === right.animate &&
    left.time === right.time;
}

function boundedMax(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : JEV_CHAT_MAX_MESSAGES;
}

/**
 * Merge polling snapshots without duplicating a node. Messages are append-only
 * within a session; a node that disappears from the bounded graph stays in the
 * transcript, and a node with the same id is updated in place.
 *
 * @param {object|null} previous
 * @param {object|null} next
 * @param {{maxMessages?: number}} [options]
 * @returns {object|null}
 */
export function mergeProgress(previous, next, { maxMessages = JEV_CHAT_MAX_MESSAGES } = {}) {
  if (next === null || typeof next !== 'object') return previous ?? null;
  const limit = boundedMax(maxMessages);
  if (next.active === false || next.mismatch === true) {
    return { ...next, messages: [] };
  }
  if (previous === null || typeof previous !== 'object' || previous.sessionId !== next.sessionId) {
    return { ...next, messages: next.messages.slice(-limit) };
  }
  if(next.authoritative) {
    const prior=new Map(previous.messages.map(message=>[message.id,message]));
    return {...next,messages:next.messages.slice(-limit).map(message=>
      prior.has(message.id)&&sameProgressMessage(prior.get(message.id),message)?prior.get(message.id):message)};
  }

  const byId = new Map();
  const order = [];
  for (const message of previous.messages) {
    if (!byId.has(message.id)) order.push(message.id);
    byId.set(message.id, message);
  }
  for (const message of next.messages) {
    if (!byId.has(message.id)) order.push(message.id);
    const prior = byId.get(message.id);
    byId.set(message.id, prior !== undefined && sameProgressMessage(prior, message) ? prior : message);
  }
  const messages = [];
  for (const id of order) {
    const message = byId.get(id);
    if (message !== undefined && message.sessionId === next.sessionId) messages.push(message);
  }
  return { ...next, messages: messages.slice(-limit) };
}

/** Group projected messages by their host turn; no-turn messages share `tail`. */
export function groupProgressMessages(messages) {
  const groups = [];
  const byKey = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const key = message.groupKey || (message.turn === null ? 'tail' : `turn:${message.turn}`);
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, turn: message.turn ?? null, messages: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.messages.push(message);
  }
  return groups;
}

function chatMeta(message) {
  if(message.kind==='task_summary')return '';
  const parts = [];
  const phase={understand:'确认条件',research:'查阅资料',plan:'制定方案',implement:'制作与实现',verify:'检查结果',debug:'处理问题',deliver:'整理交付'};
  const intent={planned:'准备开始',active:'进行中',reported_done:'完成说明',blocked:'遇到阻碍'};
  if(phase[message.phase])parts.push(phase[message.phase]);
  if(intent[message.intent])parts.push(intent[message.intent]);
  if(parts.length) {
    if(message.canceled)parts.push('已中断');
    return parts.join(' · ');
  }
  const turn = progressTurnLabel(message.turn);
  if (turn !== '') parts.push(turn);
  const step = progressStepLabel(message.step);
  if (step !== '') parts.push(step);
  if (message.canceled) parts.push('已中断');
  return parts.join(' · ');
}

function chatClock(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function createMessageElement(doc, message) {
  const article = doc.createElement('article');
  article.className = 'jev-chat-message';
  article.setAttribute('data-jev-chat-message', '');
  article.setAttribute('data-jev-chat-id', message.id);

  const avatar = doc.createElement('span');
  avatar.className = 'jev-chat-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.innerHTML=progressIcon(message.appearance);

  const main = doc.createElement('div');
  main.className = 'jev-chat-main';
  const head = doc.createElement('div');
  head.className = 'jev-chat-head';
  const label = doc.createElement('span');
  label.className = 'jev-chat-label';
  label.textContent = JEV_CHAT_LABEL;
  label.title='JeV 整理的工作进度';
  label.setAttribute('aria-label','JeV 工作进度');
  const meta = doc.createElement('span');
  meta.className = 'jev-chat-meta';
  const time = doc.createElement('time');
  time.className = 'jev-chat-time';
  const body = doc.createElement('div');
  body.className = 'jev-chat-body';
  const text = doc.createElement('p');
  text.className = 'jev-chat-text';
  const nativeTag=doc.createElement('span');nativeTag.className='jev-native-tag';
  nativeTag.innerHTML='思考<span class="jev-native-separator">·</span>';

  head.append(label, meta, time);
  body.append(nativeTag,text);
  main.append(head, body);
  article.append(avatar, main);
  return { article, meta, time, text, avatar, nativeTag };
}

function updateMessageElement(parts, message) {
  const article = parts.article;
  article.setAttribute('data-jev-kind',message.kind);
  const appearance=message.appearance??'orbit';
  if(article.dataset.jevAppearance!==appearance)parts.avatar.innerHTML=progressIcon(appearance);
  article.dataset.jevAppearance=appearance;
  article.dataset.jevSummaryAppearance=message.summaryAppearance??'plain';
  article.dataset.jevAnimate=message.animate?'true':'false';
  parts.nativeTag.hidden=appearance!=='native'||message.kind!=='progress';
  setText(article.querySelector('.jev-chat-label'),JEV_CHAT_LABEL);
  setText(parts.text, message.text);
  const meta = {task_summary:'任务摘要',plan_summary:'方案',stage_summary:'阶段小结'}[message.kind]??'';
  setText(parts.meta, meta);
  parts.meta.hidden = meta === '';
  const clock = chatClock(message.time);
  setText(parts.time, clock);
  parts.time.hidden = clock === '';
  if (clock !== '') parts.time.dateTime = new Date(message.time).toISOString();
  else parts.time.removeAttribute('datetime');
  if (article.getAttribute('data-jev-chat-turn') !== (message.turn ?? '')) {
    article.setAttribute('data-jev-chat-turn', message.turn ?? '');
  }
  if (article.getAttribute('data-jev-chat-step') !== (message.step ?? '')) {
    article.setAttribute('data-jev-chat-step', message.step ?? '');
  }
  article.setAttribute('data-jev-chat-canceled', message.canceled ? 'true' : 'false');
}

function syncThread(doc, thread, messages) {
  const desired = new Set();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    desired.add(message.id);
    let item = thread.messages.get(message.id);
    if (item === undefined) {
      const parts = createMessageElement(doc, message);
      item = { parts, message: null };
      thread.messages.set(message.id, item);
      thread.list.append(parts.article);
    }
    if (item.message === null || !sameProgressMessage(item.message, message)) {
      updateMessageElement(item.parts, message);
      item.message = message;
    }
    const current = thread.list.children[index];
    if (current !== item.parts.article) thread.list.insertBefore(item.parts.article, current ?? null);
  }
  for (const [id, item] of thread.messages) {
    if (desired.has(id)) continue;
    item.parts.article.remove();
    thread.messages.delete(id);
  }
  thread.order = messages.map(message => message.id);
  updateThreadDisclosure(thread);
}

function updateThreadDisclosure(thread) {
  const collapsible = thread.folded && thread.order.length > 4;
  const hiddenCount = collapsible && !thread.expanded ? thread.order.length - 3 : 0;
  thread.toggle.hidden = !collapsible;
  thread.toggle.setAttribute('aria-expanded', String(thread.expanded));
  setText(thread.toggle, !collapsible ? '' : thread.expanded ? '收起较早进展' : `展开此前 ${thread.order.length - 3} 条进展`);
  thread.el.dataset.jevFoldedSource = String(thread.folded);
  for (let index = 0; index < thread.order.length; index++) {
    thread.messages.get(thread.order[index]).parts.article.hidden = index < hiddenCount;
  }
}

/** Match source order without moving or changing any native thinking content. */
export function findProgressAnchor(flow,message) {
  const rows=[...flow.querySelectorAll('[data-chat-flow-kind]')].filter(row=>
    row.getAttribute('data-chat-turn')===String(message.turn));
  if(message.kind==='task_summary') {
    const user=rows.find(row=>['user','steering','turn-trigger'].includes(row.getAttribute('data-chat-flow-kind')));
    return {el:user??rows[0],after:!!user};
  }
  const displayed=element=>{
    if(!element?.getClientRects().length)return false;
    for(let parent=element;parent&&parent!==flow;parent=parent.parentElement)
      if(parent.hasAttribute('hidden'))return false;
    return typeof element.checkVisibility!=='function'||element.checkVisibility();
  };
  const matching=rows.filter(row=>row.getAttribute('data-chat-flow-kind')==='assistant-step'&&
    row.getAttribute('data-chat-node-key')?.endsWith(`assistant-step${message.turn}:${message.step}`));
  const row=matching.find(row=>row.getAttribute('data-chat-group-part')==='reasoning')??matching[0];
  if(row) {
    if(displayed(row)) {
      const bodies=[...row.querySelectorAll('[data-slot="conversation.chat.reasoning.body"]')];
      const body=bodies[Math.min(Number(message.blockIndex)||0,Math.max(0,bodies.length-1))];
      if(body&&displayed(body)) {
        const paragraphs=[...body.querySelectorAll('p,pre,ul,ol,h1,h2,h3')].filter(el=>
          !el.closest('[data-jev-chat-thread]')&&!el.parentElement?.closest('p,pre,ul,ol'));
        let length=0;
        const paragraph=paragraphs.find(el=>{length+=el.textContent.length+1;return length>=(message.sourceOffset??0);})??paragraphs.at(-1);
        if(paragraph)return {el:paragraph,after:true};
      }
      // A collapsed raw thought still has a visible preview row. Insert after
      // that row, between this thought and subsequent thoughts/tools.
      return {el:row,after:true};
    }
    // Standard mode folds many source steps into one header. Their public
    // summaries share a compact block, rather than separate chat-message gaps.
    const group=row.closest('[data-chat-group-key]')??row;
    if(displayed(group))return {el:group,after:true,folded:true};
    // A completed turn may hide the group as well. Use the visible turn
    // disclosure instead of leaving an orphan block beside hidden content.
    const disclosure=rows.find(candidate=>
      candidate.getAttribute('data-chat-flow-kind')==='turn-process'&&displayed(candidate));
    return {el:disclosure??group,after:true,folded:true};
  }
  return {el:rows.find(row=>row.getAttribute('data-chat-flow-kind')==='turn-tail')??rows.at(-1),after:false};
}

/** Co-located summaries are one paragraph block; source rows stay untouched. */
export function groupAnchoredProgress(messages, resolveAnchor) {
  const groups = [];
  const byAnchor = new Map();
  for (const message of messages) {
    const anchor = resolveAnchor(message);
    // The task overview stays independent from intermediate progress.
    const category = `${message.kind === 'task_summary' ? 'task' : 'progress'}:${Boolean(anchor.after)}`;
    const locations = byAnchor.get(anchor.el) ?? new Map();
    const prior = anchor.el && locations.get(category);
    if (prior) {
      prior.messages.push(message);
      continue;
    }
    const group = { key: message.id, anchor, messages: [message], folded: anchor.folded === true };
    groups.push(group);
    if (anchor.el) {
      locations.set(category, group);
      byAnchor.set(anchor.el, locations);
    }
  }
  return groups;
}

/**
 * Mount the UI-only progress projection. The returned disposer removes every
 * observer, timer, and inserted node. It never calls a session mutation API.
 *
 * @param {Element} container dock-owned anchor.
 * @param {{sessionId: string, load: () => Promise<unknown>, pollMs?: number, maxMessages?: number}} options
 */
export function mountProgressChat(container, options = {}) {
  const doc = container?.ownerDocument;
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
  if (container === null || container === undefined || doc === null || doc === undefined ||
      sessionId === '' || typeof options.load !== 'function') {
    return { render() {}, dispose() {} };
  }
  const win = doc.defaultView;
  const timers = win ?? globalThis;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(500, Math.min(60000, Math.trunc(options.pollMs))) : 1500;
  const maxMessages = boundedMax(options.maxMessages);
  const hasRaf = typeof win?.requestAnimationFrame === 'function' && typeof win?.cancelAnimationFrame === 'function';

  const hostRoot = doc.createElement('div');
  hostRoot.className = 'jev-chat-root';
  hostRoot.setAttribute('data-jev-chat-root', '');
  hostRoot.hidden = true;
  container.append(hostRoot);

  let disposed = false;
  let projection = null;
  let lastFlow = null;
  let pollTimer = null;
  let scheduled = 0;
  let running = false;
  const threads = new Map();
  const expandedGroups = new Map();
  const observer = typeof win?.MutationObserver === 'function' && doc.body !== null
    ? new win.MutationObserver(mutations => {
      if (disposed) return;
      if (mutations.length > 0 && mutations.every(isOwnMutation)) return;
      schedule();
    })
    : null;

  function isOwnNode(node) {
    if (node === hostRoot) return true;
    if (node === null || node === undefined || node.nodeType !== 1) return false;
    return typeof node.closest === 'function' &&
      (node.closest('[data-jev-chat-root]') !== null || node.closest('[data-jev-chat-thread]') !== null);
  }

  function isOwnMutation(mutation) {
    if (isOwnNode(mutation.target)) return true;
    const changed = [...mutation.addedNodes, ...mutation.removedNodes];
    return changed.length > 0 && changed.every(isOwnNode);
  }

  function findSessionRoot() {
    if (typeof container.closest === 'function') {
      const nearest = container.closest('[data-conversation-session]');
      if (nearest !== null && nearest.getAttribute('data-conversation-session') === sessionId) return nearest;
    }
    for (const root of doc.querySelectorAll('[data-conversation-session]')) {
      if (root.getAttribute('data-conversation-session') === sessionId) return root;
    }
    return null;
  }

  function findRowHost() {
    const root = findSessionRoot();
    if (root === null) return null;
    const column = root.querySelector('[data-chat-flow]');
    if (column === null) return null;
    for (const child of column.children) {
      if (child.getAttribute('data-slot') === 'conversation.chat.flow') return child;
    }
    return column;
  }

  function ensureThread(group) {
    let thread = threads.get(group.key);
    if (thread !== undefined) {
      thread.folded = group.folded === true;
      return thread;
    }
    const el = doc.createElement('div');
    el.className = 'jev-chat-thread';
    el.setAttribute('data-jev-chat-thread', '');
    el.setAttribute('data-jev-chat-key', group.key);
    const toggle = doc.createElement('button');
    toggle.className = 'jev-summary-disclosure';
    toggle.type = 'button';
    toggle.hidden = true;
    const list = doc.createElement('div');
    list.className = 'jev-chat-list';
    list.id = `jev-summaries-${chatHash(`${sessionId}:${group.key}`)}`;
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'polite');
    list.setAttribute('aria-relevant', 'additions text');
    toggle.setAttribute('aria-controls', list.id);
    el.append(toggle, list);
    thread = {
      el, list, toggle, messages: new Map(), order: [],
      folded: group.folded === true,
      expanded: expandedGroups.get(group.key) === true,
    };
    toggle.onclick = () => {
      thread.expanded = !thread.expanded;
      expandedGroups.set(group.key, thread.expanded);
      updateThreadDisclosure(thread);
    };
    threads.set(group.key, thread);
    return thread;
  }

  function visibleGroups(groups, turns) {
    const explicit = groups.filter(group => group.turn !== null);
    const matched = explicit.filter(group => turns.has(String(group.turn)));
    const tails = groups.filter(group => group.turn === null);
    if (turns.size === 0 && explicit.length > 0 && tails.length === 0) {
      // Compatibility fallback: if Codex's turn field is not in this host's DOM
      // shape yet, render the filtered text at the live tail instead of hiding
      // progress entirely. Association is still carried by data attributes.
      return { matched: [], tail: groups.flatMap(group => group.messages) };
    }
    return { matched, tail: tails.flatMap(group => group.messages) };
  }

  function render() {
    if (disposed) return;
    try {
      const flow = findRowHost();
      if (flow === null) return;
      if (flow !== lastFlow) {
        lastFlow = flow;
        for (const thread of threads.values()) flow.append(thread.el);
      }
      const groups = (projection?.messages??[]).filter(message=>message.kind!=='progress')
        .slice().sort((a,b)=>(Number(a.turn)-Number(b.turn))||((a.sourceAt??a.time??0)-(b.sourceAt??b.time??0))||((Number(a.step)||0)-(Number(b.step)||0))||((a.sourceOffset??0)-(b.sourceOffset??0)))
        .map(message=>({key:message.id,turn:message.turn,messages:[message]}));
      const turns = new Set();
      for (const child of flow.querySelectorAll('[data-chat-turn]')) {
        const turn = child.getAttribute('data-chat-turn');
        if (turn !== null) turns.add(turn);
      }
      const { matched, tail } = visibleGroups(groups, turns);
      const active = new Set(),afterAnchors=new Map();
      const anchored = groupAnchoredProgress(matched.flatMap(group=>group.messages),
        message=>findProgressAnchor(flow,message));

      for (const group of anchored) {
        const thread = ensureThread(group);
        active.add(group.key);
        syncThread(doc, thread, group.messages);
        const anchor = group.anchor;
        if(anchor.el) {
          if(anchor.after) {
            const cursor=afterAnchors.get(anchor.el)??anchor.el;
            if(cursor.nextElementSibling!==thread.el)cursor.after(thread.el);
            afterAnchors.set(anchor.el,thread.el);
          }
          else if(anchor.el.previousElementSibling!==thread.el)anchor.el.before(thread.el);
        } else if(!thread.el.isConnected)flow.append(thread.el);
      }

      if (tail.length > 0) {
        const thread = ensureThread({ key: 'tail', turn: null });
        active.add('tail');
        syncThread(doc, thread, tail);
        if (flow.lastElementChild !== thread.el) flow.append(thread.el);
      }

      for (const [key, thread] of threads) {
        if (active.has(key)) continue;
        thread.el.remove();
        threads.delete(key);
      }
    } catch {
      // Progress is an optional UI layer; it must never break the chat view.
    }
  }

  function schedule() {
    if (disposed || scheduled !== 0) return;
    const run = () => {
      scheduled = 0;
      render();
    };
    scheduled = hasRaf ? win.requestAnimationFrame(run) : timers.setTimeout(run, 16);
  }

  function cancelScheduled() {
    if (scheduled === 0) return;
    if (hasRaf) win.cancelAnimationFrame(scheduled);
    else timers.clearTimeout(scheduled);
    scheduled = 0;
  }

  async function poll() {
    if (disposed || running) return;
    running = true;
    try {
      const next = projectProgress(await options.load(), { sessionId });
      if (disposed) return;
      projection = mergeProgress(projection, next, { maxMessages });
      render();
    } catch {
      // Keep the last projection and retry silently; error details never enter
      // the user transcript.
    } finally {
      running = false;
      if (!disposed) pollTimer = timers.setTimeout(poll, pollMs);
    }
  }

  const observeRoot = doc.body ?? doc.documentElement;
  if (observer !== null && observeRoot !== null) {
    observer.observe(observeRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-chat-turn', 'data-chat-flow', 'data-slot','data-expanded','data-turn-process-hidden','hidden','aria-expanded','data-preview','data-group-expanded-mode'],
    });
  }
  schedule();
  void poll();

  return {
    render,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (observer !== null) observer.disconnect();
      cancelScheduled();
      if (pollTimer !== null) {
        timers.clearTimeout(pollTimer);
        pollTimer = null;
      }
      for (const thread of threads.values()) thread.el.remove();
      threads.clear();
      expandedGroups.clear();
      hostRoot.remove();
      lastFlow = null;
      projection = null;
    },
  };
}
