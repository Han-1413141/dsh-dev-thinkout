import { redactString } from './redact.js';
import { normalizeKey, oneLine, stableId } from './text.js';
import { INTENTS, PHASES, RELATIONS } from './questions.js';

export const TASK_STATUSES = Object.freeze([
  'planned',
  'active',
  'reported_done',
  'blocked',
  'completed',
  'failed',
  'canceled',
]);

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'canceled']);

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} value
 * @param {Set<string>} allowed
 * @param {string} fallback
 * @returns {string}
 */
function allowedStatus(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

/**
 * Clone a state record for a caller without exposing the internal arrays.
 * @param {object} task
 * @returns {object}
 */
function copyTask(task) {
  return {
    ...task,
    nodeIds: [...(task.nodeIds ?? [])],
    evidenceIds: [...(task.evidenceIds ?? [])],
    ...(task.lastFailure ? { lastFailure: { ...task.lastFailure } } : {}),
  };
}

/**
 * @param {object} node
 * @returns {object}
 */
function copyNode(node) {
  return { ...node };
}

/**
 * @param {object} relation
 * @returns {object}
 */
function copyRelation(relation) {
  return { ...relation };
}

/**
 * In-memory, bounded progress graph. It accepts only validated decisions and
 * explicit evidence; it has no I/O and never logs source text.
 */
export class ProgressState {
  /**
   * @param {{maxNodes?: number, maxRelations?: number, maxTasks?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.maxNodes = positiveInteger(options.maxNodes, 200);
    this.maxRelations = positiveInteger(options.maxRelations, 400);
    this.maxTasks = positiveInteger(options.maxTasks, 12);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    /** @type {object[]} */
    this.nodes = [];
    /** @type {object[]} */
    this.relations = [];
    /** @type {object[]} */
    this.tasks = [];
    this.lastUpdatedAt = null;
    this.lastToolEvidence = null;
    this.nodeSequence = 0;
  }

  /** @returns {{nodes: number, relations: number, tasks: number}} */
  get size() {
    return {
      nodes: this.nodes.length,
      relations: this.relations.length,
      tasks: this.tasks.length,
    };
  }

  /**
   * Register a host task before any evidence or decision refers to it.
   * Existing stable ids are merged; a full task set refuses new ids.
   * @param {{id?: string, title?: string, status?: string}} task
   * @param {number} [at]
   * @returns {object|null}
   */
  registerTask(task, at) {
    if (!isRecord(task)) return null;
    const timestamp = this.#time(at);
    const ensured = this.#ensureTask(task, timestamp);
    if (ensured.task !== null) {
      const status = task.status === 'completed' ? 'reported_done' : task.status;
      // An explicit host checklist update is authoritative for reported state,
      // including reopening a task as pending. It never verifies completion.
      if (INTENTS.includes(status)) {
        ensured.task.status = status;
        ensured.task.verified = false;
        ensured.task.updatedAt = timestamp;
        ensured.task.hostStatus = status;
      }
      if (typeof task.title === 'string') ensured.task.title = redactString(oneLine(task.title, 120));
    }
    return ensured.task === null ? null : copyTask(ensured.task);
  }

  /**
   * Apply one validated decision. A non-displayable decision changes nothing
   * unless `force` is set. Bad input is rejected without mutation.
   *
   * @param {object} decision
   * @param {{previousNodeId?: string, evidenceId?: string, force?: boolean, at?: number}} [options]
   * @returns {object}
   */
  apply(decision, options = {}) {
    if (!isRecord(decision) || decision.ok !== true) {
      return { updated: false, reason: 'invalid_decision' };
    }
    if (decision.shouldDisplay === false && options.force !== true) {
      return { updated: false, reason: 'not_displayable' };
    }
    if (!isRecord(decision.phase) || !PHASES.includes(decision.phase.value)) {
      return { updated: false, reason: 'invalid_phase' };
    }
    if (!isRecord(decision.intent) || !INTENTS.includes(decision.intent.value)) {
      return { updated: false, reason: 'invalid_intent' };
    }
    if (!isRecord(decision.relation) || !RELATIONS.includes(decision.relation.value)) {
      return { updated: false, reason: 'invalid_relation' };
    }

    const at = this.#time(options.at);
    const ignoredReasons = [];
    let task = null;
    if (isRecord(decision.task)) {
      const ensured = this.#ensureTask(decision.task, at);
      task = ensured.task;
      if (ensured.reason) ignoredReasons.push(ensured.reason);
    }

    if (task !== null) {
      if (options.updateTask !== false) this.#applyIntent(task, decision.intent.value, at);
      if (isRecord(decision.task) && typeof decision.task.title === 'string') {
        const title = redactString(oneLine(decision.task.title, 120));
        if (title !== '') task.title = title;
      }
    }

    const phase = decision.phase.value;
    const intent = decision.intent.value;
    const relation = decision.relation.value;
    const sentence = isRecord(decision.sentence) && typeof decision.sentence.text === 'string'
      ? redactString(oneLine(decision.sentence.text, 4000))
      : null;
    const sentenceId = isRecord(decision.sentence) && typeof decision.sentence.id === 'string'
      ? oneLine(decision.sentence.id, 80)
      : null;

    const previousId = options.previousNodeId ?? decision.relation.previousNodeId;
    const previous = this.nodes.find(entry => entry.id === previousId);
    // A return from verification to implementation is a new visit. Only a
    // consecutive continuation of the same task and stage can merge.
    let node = options.merge !== false && !previous?.cancelled && relation === 'continue' && previous?.phase === phase &&
      previous.taskId === (task?.id ?? null) ? previous : null;
    const nodeId = node?.id ?? stableId('node', `${task?.id ?? 'unassigned'}|${phase}|${++this.nodeSequence}`);
    let created = false;

    if (node === null) {
      node = {
        id: nodeId,
        taskId: task?.id ?? null,
        taskTitle: task?.title ?? null,
        phase,
        intent,
        relation,
        sentenceId,
        text: sentence,
        confidence: this.#confidence(decision.confidence),
        occurrences: 1,
        firstAt: at,
        lastAt: at,
        verified: false,
      };
      this.nodes.push(node);
      created = true;
    } else {
      node.occurrences += 1;
      node.lastAt = at;
      node.intent = intent;
      node.relation = relation;
      node.confidence = Math.max(node.confidence, this.#confidence(decision.confidence));
      if (sentence !== null) {
        node.text = sentence;
        node.sentenceId = sentenceId;
      }
      if (task !== null) {
        node.taskId = task.id;
        node.taskTitle = task.title;
      }
    }

    if (task !== null && !task.nodeIds.includes(node.id)) {
      task.nodeIds.push(node.id);
      if (task.nodeIds.length > 32) task.nodeIds.shift();
    }

    const evictedNodeIds = this.#enforceNodeCap(new Set([node.id]));
    for (const evicted of evictedNodeIds) {
      if (evicted === node.id) {
        ignoredReasons.push('node_evicted');
        node = null;
      }
    }

    let edge = null;
    if (node !== null && relation !== 'unrelated') {
      const requestedPrevious = typeof options.previousNodeId === 'string'
        ? options.previousNodeId
        : isRecord(decision.relation) && typeof decision.relation.previousNodeId === 'string'
          ? decision.relation.previousNodeId
          : null;
      if (requestedPrevious === null) {
        ignoredReasons.push('no_previous_node');
      } else if (requestedPrevious === node.id) {
        ignoredReasons.push('self_relation');
      } else if (!this.nodes.some((entry) => entry.id === requestedPrevious)) {
        ignoredReasons.push('unknown_previous_node');
      } else {
        edge = this.#addRelation({
          from: requestedPrevious,
          to: node.id,
          type: relation,
          at,
          evidenceId: typeof options.evidenceId === 'string' ? options.evidenceId : null,
        });
      }
    }

    this.lastUpdatedAt = at;
    return {
      updated: node !== null || edge !== null || task !== null,
      created,
      node: node === null ? null : copyNode(node),
      task: task === null ? null : copyTask(task),
      relation: edge === null ? null : copyRelation(edge),
      previousNodeId: edge?.from ?? null,
      ignoredReasons,
    };
  }

  /**
   * Apply explicit evidence. Generic tool success never completes a task:
   * completion requires a task id/title match plus either a task-completion
   * kind or the host's explicitTaskCompletion marker. Failures, cancellation,
   * and revisions are retained as task state.
   *
   * @param {{
   *   id?: string, kind?: string, taskId?: string, taskTitle?: string,
   *   ok?: boolean, exitCode?: number, name?: string,
   *   explicitTaskCompletion?: boolean, at?: number
   * }} evidence
   * @returns {object}
   */
  recordEvidence(evidence) {
    if (!isRecord(evidence)) return { updated: false, reason: 'invalid_evidence' };
    const at = this.#time(evidence.at);
    const kind = typeof evidence.kind === 'string'
      ? evidence.kind.toLowerCase()
      : typeof evidence.type === 'string'
        ? evidence.type.toLowerCase()
        : 'tool_result';
    const taskId = typeof evidence.taskId === 'string' ? oneLine(evidence.taskId, 100) : null;
    const taskTitle = typeof evidence.taskTitle === 'string' ? redactString(oneLine(evidence.taskTitle, 120)) : null;
    let task = taskId !== null ? this.tasks.find((entry) => entry.id === taskId) ?? null : null;
    if (task === null && taskTitle !== null) {
      const wanted = normalizeKey(taskTitle);
      task = this.tasks.find((entry) => normalizeKey(entry.title) === wanted) ?? null;
    }

    const evidenceId = typeof evidence.id === 'string' ? oneLine(evidence.id, 100) : null;
    const name = typeof evidence.name === 'string' ? redactString(oneLine(evidence.name, 60)) : null;
    const ok = evidence.ok === true ? true : evidence.ok === false ? false : undefined;
    const exitCode = Number.isSafeInteger(evidence.exitCode) ? evidence.exitCode : undefined;
    this.lastToolEvidence = {
      kind,
      name,
      ok,
      ...(exitCode === undefined ? {} : { exitCode }),
      at,
    };

    if (task === null) {
      return { updated: false, reason: 'unknown_task', task: null, kind };
    }
    if ((Number.isSafeInteger(evidence.revision) && evidence.revision !== task.revision) ||
        (Number.isFinite(task.lastEvidenceAt) && at < task.lastEvidenceAt)) {
      return { updated: false, reason: 'stale_evidence', task: copyTask(task), kind };
    }
    if (evidenceId !== null && task.evidenceIds.includes(evidenceId)) {
      return { updated: false, reason: 'duplicate_evidence', task: copyTask(task), kind };
    }
    const validCompletion = evidenceId !== null && evidenceId.trim() !== '' &&
      evidence.source === 'host' && evidence.explicitTaskCompletion === true &&
      evidence.revision === task.revision && ok === true &&
      (exitCode === undefined || exitCode === 0);

    const previousStatus = task.status;
    let updated = false;
    let outcome = 'recorded';

    if (kind === 'revision' || kind === 'revise' || kind === 'reopened') {
      task.previousStatus = previousStatus;
      task.revision += 1;
      task.status = 'active';
      task.verified = false;
      outcome = 'revision';
      updated = true;
    } else if (kind === 'canceled' || kind === 'cancelled' || kind === 'cancel') {
      task.previousStatus = previousStatus;
      task.status = 'canceled';
      task.verified = false;
      task.canceledAt = at;
      outcome = 'canceled';
      updated = true;
    } else if (kind === 'failure' || kind === 'failed' || kind === 'error' || kind === 'tool_failure') {
      task.previousStatus = previousStatus;
      task.status = 'failed';
      task.verified = false;
      task.failedAt = at;
      task.lastFailure = { name, code: evidence.code ?? null, at };
      outcome = 'failed';
      updated = true;
    } else if (kind === 'task_completed' || kind === 'completion' || kind === 'completed') {
      if (ok === false || (exitCode !== undefined && exitCode !== 0)) {
        task.previousStatus = previousStatus;
        task.status = 'failed';
        task.verified = false;
        task.failedAt = at;
        outcome = 'failed';
      } else if (validCompletion) {
        task.previousStatus = previousStatus;
        task.status = 'completed';
        task.verified = true;
        task.completedAt = at;
        outcome = 'completed';
      } else {
        return { updated: false, reason: 'completion_evidence_required', task: copyTask(task), kind };
      }
      updated = true;
    } else if (kind === 'tool_result' || kind === 'tool' || kind === 'command') {
      if (exitCode !== undefined) task.lastToolExitCode = exitCode;
      if (ok !== undefined) task.lastToolOk = ok;
      if (validCompletion) {
        task.previousStatus = previousStatus;
        task.status = 'completed';
        task.verified = true;
        task.completedAt = at;
        outcome = 'completed';
        updated = true;
      } else {
        outcome = 'tool_observed';
      }
    } else {
      task.lastEvidenceKind = kind;
      outcome = 'observed';
    }

    task.updatedAt = at;
    task.lastEvidenceAt = at;
    if (evidenceId !== null) {
      task.evidenceIds.push(evidenceId);
      if (task.evidenceIds.length > 16) task.evidenceIds.shift();
    }
    this.lastUpdatedAt = at;
    return {
      updated,
      reason: null,
      outcome,
      kind,
      task: copyTask(task),
    };
  }

  /**
   * Mark an inferred relation as a verified dependency only when the caller
   * supplies evidence. Model inference alone never calls this.
   * @param {string} relationId
   * @param {string} evidenceId
   * @param {number} [at]
   * @returns {object}
   */
  verifyRelation(relationId, evidenceId, at) {
    if (typeof relationId !== 'string' || relationId === '') {
      return { updated: false, reason: 'unknown_relation' };
    }
    if (typeof evidenceId !== 'string' || evidenceId.trim() === '') {
      return { updated: false, reason: 'evidence_required' };
    }
    const relation = this.relations.find((entry) => entry.id === relationId) ?? null;
    if (relation === null) return { updated: false, reason: 'unknown_relation' };
    const timestamp = this.#time(at);
    relation.verified = true;
    relation.inferred = false;
    relation.dependency = relation.type === 'next';
    relation.evidenceId = redactString(oneLine(evidenceId, 100));
    relation.verifiedAt = timestamp;
    this.lastUpdatedAt = timestamp;
    return { updated: true, relation: copyRelation(relation) };
  }

  /**
   * Return a detached view suitable for a UI. No raw source excerpt is stored
   * here; node text is only the selected local candidate sentence.
   * @returns {object}
   */
  snapshot() {
    return {
      version: 1,
      lastUpdatedAt: this.lastUpdatedAt,
      tasks: this.tasks.map(copyTask),
      nodes: this.nodes.map(copyNode),
      relations: this.relations.map(copyRelation),
      counts: this.size,
      limits: {
        nodes: this.maxNodes,
        relations: this.maxRelations,
        tasks: this.maxTasks,
      },
    };
  }

  /** Alias for snapshot(). */
  toJSON() {
    return this.snapshot();
  }

  /**
   * @param {unknown} value
   * @returns {number}
   */
  #time(value) {
    if (Number.isFinite(value)) return Math.trunc(value);
    const now = this.now();
    return Number.isFinite(now) ? Math.trunc(now) : Date.now();
  }

  /**
   * @param {unknown} value
   * @returns {number}
   */
  #confidence(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
  }

  /**
   * @param {{id?: string, title?: string, status?: string}} row
   * @param {number} at
   * @returns {{task: object|null, reason?: string}}
   */
  #ensureTask(row, at) {
    const explicitId = typeof row.id === 'string' && row.id.trim() !== '' ? oneLine(row.id, 100) : null;
    const title = redactString(oneLine(row.title ?? row.id ?? '', 120));
    const id = explicitId ?? (title === '' ? null : stableId('task', normalizeKey(title)));
    if (id === null) return { task: null, reason: 'task_without_identity' };

    const existing = this.tasks.find((entry) => entry.id === id) ?? null;
    if (existing !== null) return { task: existing };
    if (this.tasks.length >= this.maxTasks) {
      return { task: null, reason: 'task_capacity' };
    }

    const status = allowedStatus(row.status, new Set(TASK_STATUSES), 'planned');
    const requestedStatus = status === 'completed' ? 'reported_done' : status;
    const task = {
      id,
      title: title || id,
      status: requestedStatus,
      verified: false,
      revision: 0,
      previousStatus: null,
      nodeIds: [],
      evidenceIds: [],
      createdAt: at,
      updatedAt: at,
      lastIntent: null,
      lastToolExitCode: undefined,
      lastToolOk: undefined,
    };
    this.tasks.push(task);
    return { task };
  }

  /**
   * @param {object} task
   * @param {string} intent
   * @param {number} at
   */
  #applyIntent(task, intent, at) {
    task.lastIntent = intent;
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      task.updatedAt = at;
      return;
    }
    if (intent === 'reported_done') {
      // A model report never clears a previously recorded blocker or converts
      // any model-only claim into verified completion.
      if (task.status !== 'blocked') {
        task.status = 'reported_done';
        task.verified = false;
      }
    } else if (intent === 'blocked') {
      task.status = 'blocked';
      task.verified = false;
    } else if (intent === 'active') {
      task.status = 'active';
      task.verified = false;
    } else if (intent === 'planned' && (task.status === 'planned' || task.status === 'unknown')) {
      task.status = 'planned';
      task.verified = false;
    }
    task.updatedAt = at;
  }

  /**
   * @param {{from: string, to: string, type: string, at: number, evidenceId: string|null}} input
   * @returns {object}
   */
  #addRelation(input) {
    const existing = this.relations.find(
      (entry) => entry.from === input.from && entry.to === input.to && entry.type === input.type,
    );
    if (existing !== undefined) {
      existing.count += 1;
      existing.at = input.at;
      if (input.evidenceId !== null) existing.evidenceId = input.evidenceId;
      return existing;
    }
    const edge = {
      id: stableId('edge', input.from, input.to, input.type),
      from: input.from,
      to: input.to,
      type: input.type,
      inferred: true,
      verified: false,
      dependency: false,
      evidenceId: input.evidenceId,
      count: 1,
      at: input.at,
    };
    this.relations.push(edge);
    while (this.relations.length > this.maxRelations) this.relations.shift();
    return edge;
  }

  /**
   * @param {Set<string>} protectedIds
   * @returns {string[]}
   */
  #enforceNodeCap(protectedIds) {
    const evicted = [];
    while (this.nodes.length > this.maxNodes) {
      let index = this.nodes.findIndex((entry) => !protectedIds.has(entry.id));
      if (index === -1) index = 0;
      const [removed] = this.nodes.splice(index, 1);
      evicted.push(removed.id);
      this.relations = this.relations.filter((entry) => entry.from !== removed.id && entry.to !== removed.id);
      for (const task of this.tasks) {
        task.nodeIds = task.nodeIds.filter((nodeId) => nodeId !== removed.id);
      }
    }
    return evicted;
  }
}
