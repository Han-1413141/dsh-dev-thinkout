import { LineSegmenter } from './core/line-segmenter.js';
import { ProgressState } from './core/progress-state.js';
import { redactString } from './core/redact.js';
import { normalizeKey, stableId } from './core/text.js';
import { classifySummaries } from './summary-classify.js';
import { userGoal } from './session-context.js';
import { ProgressReports } from './progress-reports.js';
import { buildSummary, fallbackStatus } from './core/activities.js';
import { normalizeOutputPolicy } from './output-policy.js';
import { LightUsage } from './light-usage.js';

const PHASE_LABELS = { understand:'理解需求', research:'查阅资料', plan:'制定方案', implement:'实现功能', verify:'验证结果', debug:'排查问题', deliver:'整理交付', other:'处理任务' };
const INTENT_LABELS = { planned:'准备', active:'正在', reported_done:'已报告', blocked:'遇到阻碍' };
const TOOL_ACTIVITIES={read:'research',grep:'research',glob:'research',write:'produce_files',edit:'implement'};
export function statusLine(text,intent) {
  if(!/[\u3400-\u9fff]/.test(text))return text;
  let line=text.replace(/^(?:我|我们)(?:现在)?/,'').replace(/[。.!！]+$/,'').trim();
  if(intent==='planned') {
    line=line.replace(/^下一步(?:是)?/,'');
    if(!/规划|计划|准备|梳理|安排|构思|拟定/.test(line))line=`规划：${line}`;
  }
  if(['active','planned'].includes(intent)&&!/^正在/.test(line))line=`正在${line}`;
  return line;
}
const errorCode = error => /^[a-z0-9_]{1,40}$/.test(error?.code) ? error.code : 'translation_failed';
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(Object.assign(Error('cancelled'), { code:'cancelled' }));
  const abort = () => { clearTimeout(timer); reject(Object.assign(Error('cancelled'), { code:'cancelled' })); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once:true });
});

export class ProgressPipeline {
  constructor({ sessionId, client, translator, narrator, summaryMode='light', appearance='whale', summaryAppearance='plain', showStatusBar=true, flowDirection='horizontal', outputPolicy, onChange = () => {}, now = Date.now, maxNodes = 120 }) {
    Object.assign(this, { sessionId, client, translator, narrator, onChange, now, provider:'deepseek-official' });
    this.summaryMode=summaryMode==='native'?'native':'light';
    this.appearance=['orbit','whale','native','none'].includes(appearance)?appearance:'whale';
    this.summaryAppearance=summaryAppearance==='tagged'?'tagged':'plain';
    this.showStatusBar=showStatusBar!==false;
    this.flowDirection=flowDirection==='vertical'?'vertical':'horizontal';
    this.outputPolicy=normalizeOutputPolicy(outputPolicy);
    this.graph = new ProgressState({ maxNodes, maxRelations:240, now });
    this.segmenters = new Map();
    this.attempts = new Map();
    this.queue = [];
    this.busy = false;
    this.running = false;
    this.controller = new AbortController();
    this.evidence = [];
    this.tools = new Map();
    this.lightUsage=new LightUsage();
    this.jevUsage=new LightUsage('vllm-sr/d3-turbo');
    this.lastNodeId = null;
    this.lastActivity = now();
    this.lastProgress = 0;
    this.lastRevision = 0;
    this.issue = null;
    this.stats = { segments:0, classified:0, calls:0, suppressed:0, coalesced:0, dropped:0,
      oversized:0, failures:0, translated:0, cancelled:0, narrated:0, narratorFallbacks:0, endToEndMs:[] };
    this.lastText = '';
    this.reports = new ProgressReports({now,onPublish:(report,updates)=>{
      this.lastProgress=this.now();
      this.stats.coalesced=this.reports.coalesced;
      this.stats.endToEndMs.push(...updates.map(update=>Math.max(0,this.now()-update.sourceAt)));
      this.stats.endToEndMs=this.stats.endToEndMs.slice(-300);
      this.changed();
    }});
    this.taskEpoch = 0;
    this.activeBatch = null;
    this.generation = 0;
    this.title = '当前任务';
    this.taskGoal = '';
    this.goalSeq = null;
    this.previousExcerpt = '';
    this.turn = null;
    this.lastPublicMessage = '';
    this.finalReconciliation = null;
    this.refinements = new Map();
    this.disposed = false;
  }

  get messages() {return this.reports.messages;}
  setRunning(running) { this.running = running; this.lastActivity = this.now(); if(!running&&!this.busy)this.reports.flush(true);this.changed(); }
  changed() { if (!this.disposed) this.onChange(this.snapshot()); }

  restore(state) {
    if(state?.presentation!=='stage-summary-v3'||state?.sessionId!==this.sessionId || !Array.isArray(state.graph?.nodes) || !Array.isArray(state.messages))return;
    // This is the plugin's bounded display cache, not conversation history.
    this.graph.nodes=state.graph.nodes.slice(-120);
    this.graph.relations=(state.graph.relations||[]).slice(-240);
    this.graph.tasks=(state.graph.tasks||[]).slice(-12);
    this.graph.nodeSequence=Math.max(this.graph.nodes.length,Number(state.nodeSequence)||0);
    this.graph.lastUpdatedAt=state.graph.lastUpdatedAt;
    this.reports.restore(state.messages,state.messageSequence);
    this.lastNodeId=this.graph.nodes.at(-1)?.id??null;
    this.lastProgress=Number(state.lastProgress)||0;
    this.title=typeof state.title==='string'?state.title.slice(0,80):this.title;
    this.taskGoal=typeof state.taskGoal==='string'?redactString(state.taskGoal).slice(0,800):'';
    this.goalSeq=Number.isSafeInteger(state.goalSeq)?state.goalSeq:null;
    if(['light','native'].includes(state.summaryMode))this.summaryMode=state.summaryMode;
    if(['orbit','whale','native','none'].includes(state.appearance))this.appearance=state.appearance;
    if(state.outputPolicy)this.outputPolicy=normalizeOutputPolicy(state.outputPolicy);
    this.lightUsage.restore(state.lightUsage);
    this.jevUsage.restore(state.jevUsage);
    if(['tagged','plain'].includes(state.summaryAppearance))this.summaryAppearance=state.summaryAppearance;
    if(typeof state.showStatusBar==='boolean')this.showStatusBar=state.showStatusBar;
    if(['horizontal','vertical'].includes(state.flowDirection))this.flowDirection=state.flowDirection;
  }
  setFlowDirection(direction) {
    if(!['horizontal','vertical'].includes(direction))throw Error('invalid_flow_direction');
    this.flowDirection=direction;this.changed();
  }
  setOutputPolicy(policy) {this.outputPolicy=normalizeOutputPolicy(policy);this.changed();}
  setSummaryMode(mode) {
    if(!['light','native'].includes(mode))throw Error('invalid_summary_mode');
    if(this.summaryMode===mode)return;
    this.summaryMode=mode;
    for(const entry of this.refinements.values())entry.controller.abort();
    this.changed();
  }
  setAppearance(appearance) {
    if(!['orbit','whale','native','none'].includes(appearance))throw Error('invalid_appearance');
    this.appearance=appearance;this.changed();
  }
  setSummaryAppearance(appearance) {
    if(!['tagged','plain'].includes(appearance))throw Error('invalid_summary_appearance');
    this.summaryAppearance=appearance;this.changed();
  }
  setDisplay(visible) {
    if(typeof visible!=='boolean')throw Error('invalid_display');
    this.showStatusBar=visible;this.changed();
  }

  onFrame(frame) {
    if (this.disposed || !frame || typeof frame.attemptId !== 'string') return;
    if (frame.type === 'start' && frame.revision === 1 && this.lastRevision > 1) {
      // Agent recreation can reuse session-local attempt numbering.
      this.cancelPending(false);
      this.lastRevision = 0;
    }
    if (Number.isFinite(frame.revision)) {
      if (frame.revision <= this.lastRevision) return;
      this.lastRevision = frame.revision;
    }
    this.lastActivity = this.now();
    if (frame.type === 'start') {
      this.lastText = '';
      this.turn = frame.turn??this.turn;
      this.attempts.set(frame.attemptId, { id:frame.attemptId, turn:frame.turn, step:frame.step, controller:new AbortController(), committed:false });
      while (this.attempts.size > 64) this.attempts.delete(this.attempts.keys().next().value);
      this.running = true;
      this.issue = null;
      this.changed();
      return;
    }
    const attempt = this.attempts.get(frame.attemptId);
    if (!attempt || attempt.controller.signal.aborted) return;
    const chunk = frame.chunk;
    if (frame.type === 'chunk' && chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      const key = `${frame.attemptId}:${chunk.index}`;
      if (!this.segmenters.has(key)) {
        if (this.segmenters.size >= 16) { this.stats.dropped++; return; }
        this.segmenters.set(key, { segmenter:new LineSegmenter({ maxLineLength:16000 }), skip:false, privateKey:false, attempt, index:chunk.index, offset:0 });
      }
      const block = this.segmenters.get(key);
      for (const segment of block.segmenter.push(chunk.text)) this.acceptSegment(block, segment, frame.time);
    } else if (frame.type === 'chunk' && chunk?.type === 'block-end' && chunk.block?.type === 'reasoning') {
      this.flush(`${frame.attemptId}:${chunk.index}`);
    } else if (frame.type === 'end') {
      if (frame.outcome?.kind === 'abandoned') {
        this.cancelAttempt(attempt, true);
        this.issue = '本次尝试已中断，等待新的执行';
      } else {
        attempt.committed = true;
        for (const key of [...this.segmenters.keys()]) if (key.startsWith(`${frame.attemptId}:`)) this.flush(key);
      }
      this.changed();
    }
  }

  acceptSegment(block, segment, at) {
    // Redact complete logical lines. Sending arbitrary fragments separately
    // could split a credential from its prefix or lose a trailing negation.
    if (segment.overflow) {
      if (!block.skip) this.stats.oversized++;
      block.skip = true;
    }
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(segment.text)) block.privateKey = true;
    const privateKey = block.privateKey;
    if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(segment.text)) block.privateKey = false;
    if (segment.complete) {
      block.offset+=segment.text.length+1;
      const fence = /^\s*(```|~~~)/.exec(segment.text);
      if (fence) block.fence = block.fence ? null : fence[1];
      const code = block.fence || fence || /^\s*(?:import\s|export\s|const\s|let\s|var\s|function\s|class\s|return[;\s]|[{}[\]]\s*[,;]?\s*$)/.test(segment.text);
      if (!block.skip && !privateKey && !code) this.enqueue(segment.text, at, block.attempt,
        {blockIndex:block.index,sourceOffset:block.offset});
      else if (code) this.stats.suppressed++;
      else this.stats.dropped++;
      block.skip = false;
    }
  }

  flush(key) {
    const block = this.segmenters.get(key);
    if (!block) return;
    for (const segment of block.segmenter.flush()) this.acceptSegment(block, segment, this.now());
    this.segmenters.delete(key);
  }

  enqueue(text, at = this.now(), attempt = null, extra = {}) {
    text = redactString(text).trim();
    if (!text || this.disposed || attempt?.controller.signal.aborted) return;
    this.stats.segments++;
    const fingerprint=`${extra.focusActivity??''}:${extra.focusTaskId??''}:${text}`;
    if (fingerprint === this.lastText) { this.stats.suppressed++; return; }
    this.lastText = fingerprint;
    // Preserve the opening paragraph during a fast burst, then retain recent
    // work. Otherwise the first plan can disappear before the 60 ms batch starts.
    if (this.queue.length >= 16) {
      const keepOpening = !this.messages.some(message=>message.goalSeq===this.goalSeq) &&
        !this.activeBatch && this.queue.length > 1;
      this.queue.splice(keepOpening ? 1 : 0,1);
      this.stats.dropped++;
    }
    const previousExcerpt = this.previousExcerpt;
    this.previousExcerpt = text.slice(-600);
    this.queue.push({ text, previousExcerpt, taskGoal:this.taskGoal, goalSeq:this.goalSeq,
      at:Number.isFinite(at) ? at : this.now(), attempt, taskEpoch:this.taskEpoch, retries:0,...extra });
    void this.drain();
  }

  cancelAttempt(attempt, invalidate) {
    attempt.controller.abort();
    this.lastText = '';
    if (this.activeBatch?.items.every(item=>item.attempt?.controller.signal.aborted)) this.activeBatch.controller.abort();
    const before = this.queue.length;
    this.queue = this.queue.filter(item => item.attempt !== attempt);
    this.stats.cancelled += before - this.queue.length;
    for (const [key, block] of this.segmenters) if (block.attempt === attempt) this.segmenters.delete(key);
    if (invalidate) {
      for (const node of this.graph.nodes) if (node.attemptId === attempt.id && !node.verified) {
        node.cancelled = true;
        node.intent = 'blocked';
      }
      this.reports.cancel(attempt.id);
      for (const task of this.graph.tasks) if (task.lastProgressAttempt === attempt.id && !task.verified) {
        task.status = task.hostStatus || 'blocked';
        task.lastProgressAttempt = null;
      }
    }
  }

  cancelPending(invalidate = false) {
    this.generation++;
    for(const entry of this.refinements.values())entry.controller.abort();
    this.activeBatch?.controller.abort();
    for (const attempt of this.attempts.values()) this.cancelAttempt(attempt, invalidate && !attempt.committed);
    this.queue = [];
    this.reports.clearPending();
    this.segmenters.clear();
    this.attempts.clear();
    this.lastText = '';
    this.finalReconciliation = null;
  }

  onEvent(event) {
    if (this.disposed) return;
    const data = event.data || {};
    if (event.type === 'turn/start') {
      this.cancelPending(false);
      this.previousExcerpt = '';
      this.lastPublicMessage = '';
      this.lastNodeId = null;
        this.evidence = [];
      this.turn = data.turn;
      this.issue = null;
      this.running = true;
    }
    if (event.type === 'todo/write') {
      this.taskEpoch++;
      const todos = (data.todos || []).slice(0,12);
      const idFor = todo => stableId('task',normalizeKey(redactString(todo.content || todo.title || '')));
      const ids = new Set(todos.map(idFor));
      this.graph.tasks = this.graph.tasks.filter(task => ids.has(task.id));
      for (const todo of todos) {
        const title = redactString(todo.content || todo.title || '').slice(0,120);
        if (!title) continue;
        const id = idFor(todo);
        const previous = this.graph.tasks.find(task => task.id === id);
        if (todo.status === 'in_progress' && previous && ['completed','failed','canceled'].includes(previous.status)) {
          this.graph.recordEvidence({ id:`todo-${event.seq}`, kind:'revision', taskId:id });
        }
        this.graph.registerTask({ id, title, status:todo.status === 'in_progress' ? 'active' : todo.status === 'completed' ? 'reported_done' : 'planned' });
      }
      this.changed();
    }
    if (event.type === 'user/message') {
      const goal = userGoal(event);
      if (goal) {
        this.taskGoal = goal;
        this.goalSeq = Number.isSafeInteger(event.seq)?event.seq:null;
        this.title = goal.slice(0,80);
        this.changed();
      }
    }
    if (event.type === 'tool/call') {
      let args = {}; try { args = JSON.parse(data.arguments); } catch {}
      const object = args.file_path || args.path || args.pattern || '';
      this.tools.set(data.callId, { name:redactString(String(data.name)).slice(0,60),
        activity:TOOL_ACTIVITIES[data.name]??null,
        object:redactString(String(object)).slice(0,120), startedAt:this.now() });
      if (this.tools.size > 40) this.tools.delete(this.tools.keys().next().value);
      this.lastActivity = this.now();
      this.changed();
    }
    if (event.type === 'tool/result') {
      const message = data.message || {};
      const id = message.toolCallId || message.source?.callId;
      const tool = this.tools.get(id);
      if (tool) {
        this.tools.delete(id);
        const resultText = (message.content || []).filter(b=>b.type==='text').map(b=>b.text).join('\n');
        const exitMatch = resultText.match(/(?:exit code|exited with code)[:\s]+(-?\d+)/i);
        const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
        const failed = message.isError === true || (exitCode !== undefined && exitCode !== 0) ||
          /"isError"\s*:\s*true|TOOL_NOT_STARTED|TOOL_OUTCOME_UNKNOWN/.test(resultText);
        this.evidence.push({ id, name:tool.name, kind:'tool_result', status:failed?'failed':'returned',
          activity:tool.activity,startedAt:tool.startedAt,
          ok:failed?false:exitCode===0?true:undefined, exitCode,
          summary:`${tool.name}: ${tool.object}；${failed?'执行失败':'工具已返回'}` });
        this.evidence = this.evidence.slice(-6);
        this.lastActivity = this.now();
        this.changed();
      }
    }
    if(event.type==='assistant/message') {
      const content=data.message?.content??data.content??[];
      const text=content.filter?.(block=>block.type==='text').map(block=>block.text).join('\n')??'';
      if(text.trim())this.lastPublicMessage=redactString(text).slice(0,4000);
    }
    if (event.type === 'turn/end') {
      this.running = false;
      const reason = data.reason?.kind || data.reason;
      if (['aborted','cancelled','canceled','error'].includes(reason)) {
        this.cancelPending(true);
        this.issue = reason === 'error' ? '本轮执行出错' : '本轮任务已停止';
      } else if(reason==='completed'&&this.lastPublicMessage) {
        this.finalReconciliation={text:this.lastPublicMessage,turn:this.turn,goalSeq:this.goalSeq};
        void this.drain();
      }
      this.tools.clear();
      if(!this.busy)this.reports.flush(true);
      this.changed();
    }
  }

  async drain() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      while ((this.queue.length || this.finalReconciliation) && !this.disposed) {
        if(!this.queue.length&&this.finalReconciliation) {
          const final=this.finalReconciliation;this.finalReconciliation=null;
          const activities=[...new Set(this.graph.nodes.filter(node=>!node.cancelled&&
            node.turn===final.turn&&node.goalSeq===final.goalSeq).map(node=>node.activity).filter(Boolean))].slice(-4);
          for(const activity of activities)this.enqueue(final.text,this.now(),null,{
            focusActivity:activity,finalReport:true,finalTurn:final.turn,
          });
          for(const task of this.graph.tasks.filter(task=>!task.verified).slice(0,12))
            this.enqueue(final.text,this.now(),null,{focusTaskId:task.id,finalReport:true,finalTurn:final.turn});
          if(!this.queue.length)continue;
        }
        // Allow chunks from the same streaming burst to share an HTTP request.
        await wait(60,this.controller.signal);
        const batch = this.queue.splice(0,4);
        if (!batch.length) continue;
        const generation = this.generation;
        const batchController = new AbortController();
        const batchHandle = {controller:batchController,items:batch};
        this.activeBatch = batchHandle;
        const commonSignal = AbortSignal.any([this.controller.signal,batchController.signal]);
        const before = this.graph.snapshot();
        const previousNodeId = this.lastNodeId;
        const makeContext = item => ({outputPolicy:this.outputPolicy,text:item.text,taskGoal:item.taskGoal,previousExcerpt:item.previousExcerpt,
          focusActivity:item.focusActivity,
          focusTaskId:item.focusTaskId,
          needsTaskSummary:!item.finalReport&&!this.reports.hasTaskSummary(item.goalSeq),
          currentStep:{turn:item.attempt?.turn??this.turn,step:item.attempt?.step,
            firstUpdate:!this.messages.some(message=>message.kind!=='task_summary'&&message.goalSeq===item.goalSeq),
            activeTools:[...this.tools.values()].map(tool=>({name:tool.name,object:tool.object})).slice(-3)},
          priorNodes:before.nodes.filter(node=>!node.cancelled&&node.turn===(item.attempt?.turn??this.turn)).slice(-8).map(node=>({id:node.id,text:node.summary||node.text||''})),
          tasks:before.tasks,recentSummaries:this.publicSummaryContext(),
          toolEvidence:this.evidence,previousNode:before.nodes.find(node=>node.id===previousNodeId)});
        let batchResult;
        try {
          batchResult = await classifySummaries(this.client,batch.map(makeContext),commonSignal,
            {sessionId:this.sessionId,turn:batch[0].attempt?.turn??this.turn,step:batch[0].attempt?.step??null});
          this.stats.calls += batchResult.apiCalls;
        } catch (error) {
          batchResult = {items:batch.map(()=>({error}))};
        }
        if (commonSignal.aborted || generation !== this.generation) {
          if (this.activeBatch === batchHandle) this.activeBatch = null;
          continue;
        }
        for(let index=0;index<batch.length;index++) {
          const item=batch[index],summary=batchResult.items[index]?.decision?.taskSummary;
          if(!summary||this.reports.hasTaskSummary(item.goalSeq)||item.attempt?.controller.signal.aborted)continue;
          try {
            const text=await this.translate(summary,commonSignal);
            if(commonSignal.aborted||generation!==this.generation||item.attempt?.controller.signal.aborted)continue;
            this.reports.setTaskSummary({goalSeq:item.goalSeq,turn:item.attempt?.turn??this.turn,
              step:item.attempt?.step,text,sourceAt:item.at});
          } catch {this.stats.failures++;}
        }
        // Translation requests run concurrently; results still publish in
        // source order. This keeps a slow first translation from reordering chat.
        const batchSeen = new Set();
        const translations = batchResult.items.map(async (result,index) => {
          const item = batch[index], decision = result.decision;
          if (result.error || !decision?.shouldDisplay || !decision.sentence) return result;
          if(decision.intent.value==='planned'&&decision.activity&&!item.finalReport) {
            const observed=[...this.tools.values(),...this.evidence].find(tool=>
              tool.activity===decision.activity.value&&tool.startedAt>=item.at);
            if(observed) {
              decision.intent={...decision.intent,value:observed.status==='failed'?'blocked':'active'};
              decision.sentence=buildSummary(decision.activity.value,decision.intent.value,decision.task?.id)?.sentence;
              decision.observedStatus=observed.status==='failed'?'tool_failed':'tool_started';
            }
          }
          let statusDuplicate=false;
          if(decision.activity&&!item.finalReport) {
            const summary={goalSeq:item.goalSeq,taskId:decision.task?.id??null,
              activity:decision.activity.value,intent:decision.intent.value,
              phase:decision.phase.value,turn:item.attempt?.turn??this.turn,step:item.attempt?.step,
              novel:decision.novel,relation:decision.relation.value,updateKind:decision.updateKind};
            const key=`${this.reports.key(summary)}:${summary.intent}:${summary.phase}`;
            statusDuplicate=this.reports.has(summary)||batchSeen.has(key);
            if(statusDuplicate&&!this.reports.canSummarize(summary))return {...result,suppressed:true};
            batchSeen.add(key);
          }
          const signal = item.attempt
            ? AbortSignal.any([commonSignal,item.attempt.controller.signal]) : commonSignal;
          if (signal.aborted) return {cancelled:true};
          const selected = redactString(decision.sentence.text);
          try {
            // A concise status appears immediately; slow rewriting and native
            // translation refine it separately without holding up JeV's queue.
            const translated=this.narrator||this.summaryMode==='native'?fallbackStatus(decision.activity.value,decision.intent.value):
              statusLine(await this.translate(selected,signal),decision.intent.value);
            return {decision,selected,translated,summary:'',statusDuplicate};
          } catch(error) {return {error};}
        });
        const completed = await Promise.all(translations);
        if (this.activeBatch === batchHandle) this.activeBatch = null;
        const retryItems = [];
        const reportUpdates = [];
        const finalUpdates = [];
        const toRefine = [];
        let retryAfterMs = 0;
        for (let index=0;index<batch.length;index++) {
        const item = batch[index];
        const signal = item.attempt
          ? AbortSignal.any([this.controller.signal, item.attempt.controller.signal])
          : this.controller.signal;
        if (signal.aborted || generation !== this.generation) continue;
        try {
          const result = completed[index];
          if (result.error) throw result.error;
          if (result.cancelled) continue;
          const {decision,selected} = result;
          if (signal.aborted) continue;
          this.stats.classified++;
          if(result.suppressed){this.stats.suppressed++;continue;}
          if (!decision.shouldDisplay || !decision.sentence) { this.stats.suppressed++; continue; }
          let translated = result.translated;
          if (signal.aborted || this.disposed) continue;
          translated = redactString(String(translated)).replace(/\s+/g,' ').trim();
          if (!translated || translated.length > 4000) throw Object.assign(Error('invalid_translation'),{code:'invalid_translation'});
          decision.sentence = { ...decision.sentence, text:translated };
          if (decision.task && (decision.task.confidence < 0.6 ||
              !this.graph.tasks.some(task=>task.id===decision.task.id))) decision.task = null;
          if (decision.relation.confidence < 0.55) decision.relation.value = 'unrelated';
          const existing=[...this.graph.nodes].reverse().find(node=>!node.cancelled&&
            (item.focusTaskId?node.taskId===item.focusTaskId:node.activity===decision.activity.value&&
              node.taskId===(decision.task?.id??null)&&(item.finalReport||decision.relation.value==='continue'))&&
            node.turn===(item.finalTurn??item.attempt?.turn??this.turn)&&node.goalSeq===item.goalSeq);
          if(item.finalReport&&decision.intent.value==='planned')continue;
          if(item.finalReport&&!item.focusTaskId&&!existing)continue;
          if(item.focusTaskId&&(decision.task?.id!==item.focusTaskId||
            (decision.intent.value==='reported_done'&&!decision.taskCompletionReported)))continue;
          const relation=decision.relation.value;
          if(existing) {
            decision.relation.value='continue';
            decision.task=existing.taskId?{...this.graph.tasks.find(task=>task.id===existing.taskId),confidence:1}:null;
            if(item.finalReport&&decision.intent.value==='reported_done'&&existing.text) {
              translated='已报告完成：'+existing.text.replace(/^(?:正在|已报告完成：)/,'').replace(/^规划[：:]/,'');
              decision.sentence.text=translated;
            }
          }
          const predecessorId=existing?.id??(decision.relation.previousNodeId!==undefined?decision.relation.previousNodeId:this.lastNodeId);
          const applied = result.statusDuplicate&&existing?{node:existing}:this.graph.apply(decision, {previousNodeId:predecessorId,at:this.now(),
            updateTask:(!item.finalReport||!!item.focusTaskId)&&item.taskEpoch===this.taskEpoch&&
              (decision.intent.value!=='reported_done'||decision.taskCompletionReported),
            merge:!!existing});
          if (applied.node) {
            this.lastNodeId = applied.node.id;
            const stored = this.graph.nodes.find(node=>node.id===applied.node.id);
            stored.attemptId = item.attempt?.id ?? stored.attemptId??null;
            stored.turn = item.attempt?.turn??item.finalTurn??this.turn;
            stored.step = item.attempt?.step??stored.step;
            stored.activity=decision.activity.value;
            stored.goalSeq=item.goalSeq;
            if(result.summary)stored.summary=result.summary;
            if (applied.task && item.taskEpoch===this.taskEpoch) {
              this.graph.tasks.find(task=>task.id===applied.task.id).lastProgressAttempt=stored.attemptId;
            }
            (item.finalReport?finalUpdates:reportUpdates).push({nodeId:stored.id,previousNodeId:predecessorId,
              attemptId:stored.attemptId,turn:stored.turn,step:stored.step,goalSeq:item.goalSeq,at:this.now(),
              sourceAt:item.at,activity:decision.activity?.value,taskId:stored.taskId,
              text:result.statusDuplicate?stored.text:translated,phase:stored.phase,intent:stored.intent,
              refineStatus:!result.statusDuplicate,
              blockIndex:item.blockIndex,sourceOffset:item.sourceOffset,
              relation,novel:decision.novel,updateKind:decision.updateKind,summary:result.summary});
            if((this.narrator||this.summaryMode==='native')&&!item.finalReport)toRefine.push({item,decision,update:reportUpdates.at(-1)});
          }
          this.issue = null;
        } catch (error) {
          if (signal.aborted || this.disposed) { this.stats.cancelled++; continue; }
          this.stats.failures++;
          const code = errorCode(error);
          this.issue = code === 'missing_key' ? '请配置 JeV 密钥' : `进度服务暂不可用（${code}）`;
          if (['http_429','http_503','rate_limited'].includes(code) && item.retries < 1) {
            retryItems.push(item);
            retryAfterMs = Math.max(retryAfterMs,error.retryAfterMs || 1000);
          }
        } finally { this.changed(); }
        }
        this.reports.offer(reportUpdates,{finished:!this.running});
        this.reports.reconcile(finalUpdates);
        for(const entry of toRefine)this.refine(entry,generation);
        // A batch shares one server cooldown. Waiting once preserves order
        // without multiplying Retry-After by the number of paragraphs.
        if (retryItems.length) {
          await wait(Math.min(120000,Math.max(1000,retryAfterMs)),this.controller.signal);
          for (const item of retryItems.reverse()) {
            if (item.attempt?.controller.signal.aborted) { this.stats.cancelled++; continue; }
            if (this.queue.length < 16) this.queue.unshift({...item,retries:item.retries+1});
            else this.stats.dropped++;
          }
        }
      }
    } catch(error) {
      if (!this.disposed && !this.controller.signal.aborted) this.issue='进度整理中断';
    } finally {
      this.busy = false;
      if(!this.running)this.reports.flush(true);
      this.changed();
    }
  }

  refine({item,decision,update},generation) {
    const activityKey=this.reports.key(update);
    const key=this.reports.canSummarize(update)?
      activityKey+':summary:'+String(update.attemptId)+':'+String(update.step)+':'+String(update.sourceOffset??update.sourceAt):activityKey;
    this.refinements.get(key)?.controller.abort();
    if(this.refinements.size>=8&&!this.refinements.has(key)){this.stats.narratorFallbacks++;return;}
    const entry={controller:new AbortController()};
    this.refinements.set(key,entry);
    const mode=this.summaryMode;
    const signal=AbortSignal.any([this.controller.signal,entry.controller.signal,
      ...(item.attempt?[item.attempt.controller.signal]:[])]);
    void (async()=>{
      try {
        let status=update.text,summary='',written;
        if(mode==='native') {
          if(!this.reports.canSummarize(update)||!decision.recap)return;
          summary=await this.translate(decision.recap,signal);
        } else {
          written=await this.narrator({sessionId:this.sessionId,turn:update.turn,step:update.step,provider:this.provider,
            text:item.summaryText??item.text,previousExcerpt:item.previousExcerpt,taskGoal:item.taskGoal,
            activity:decision.activity.value,intent:decision.intent.value,
            kind:decision.novel?decision.updateKind:'progress',previousUpdate:this.publicSummaryContext().join(' '),
            publishedSummaries:this.publishedSummaries()},signal);
          status=written.status;summary=written.summary;
        }
        if(signal.aborted||generation!==this.generation||this.refinements.get(key)!==entry)return;
        const latest=this.reports.latest.get(activityKey);
        if(!latest)return;
        const currentStatus=latest.intent===update.intent&&(latest.sourceAt??0)<=(update.sourceAt??0);
        const node=this.graph.nodes.find(node=>node.id===update.nodeId);
        const text=update.refineStatus===false||!currentStatus?latest.text:statusLine(status,update.intent);
        if(node&&!node.cancelled&&node.intent===update.intent&&currentStatus) {
          node.text=text;if(summary)node.summary=summary;
        }
        if(mode==='light')this.stats.narrated++;
        this.reports.refine({...update,text,summary,workItem:written?.workItem??'',summaryMode:mode,refineStatus:update.refineStatus!==false&&currentStatus});
      } catch(error) {
        if(!signal.aborted)this.stats.narratorFallbacks++;
      } finally {
        if(this.refinements.get(key)===entry)this.refinements.delete(key);
        this.changed();
      }
    })();
  }

  publishedSummaries() {
    return this.messages.filter(message=>!message.cancelled&&message.kind!=='progress'&&message.kind!=='task_summary'&&
      message.goalSeq===this.goalSeq&&message.turn===this.turn).slice(-6).map(message=>message.text.slice(0,240));
  }
  publicSummaryContext() {
    // Keep actual public findings, not repeated generic activity labels.
    const summaries=this.publishedSummaries();
    return [summaries.slice(-6,-3).join(' ').slice(-240),summaries.slice(-3).join(' ').slice(-240)].filter(Boolean);
  }

  async translate(text,signal) {
    let translated=text;
    if (!/[\u3400-\u9fff]/.test(text) || /[a-zA-Z]{8,}/.test(text)) {
      const request={text,targetLanguage:'zh-Hans'};
      let spec;
      // Never pass a main Session to the translator: paid providers require
      // its durable log. Native mode uses the built-in anonymous translation.
      try {spec={...this.translator.resolve(request)};}
      catch(error) {
        if(error?.code!=='TRANSLATION_SESSION_REQUIRED')throw error;
        spec={...this.translator.resolve({...request,provider:'bing'})};
      }
      if(['deepseek-account','deepseek-official'].includes(spec.provider))
        spec={...this.translator.resolve({...request,provider:'bing'})};
      delete spec.sessionId;
      translated=await this.translator.translate(spec,signal);
      this.stats.translated++;
    }
    translated=redactString(String(translated)).replace(/\s+/g,' ').trim();
    if(!translated||translated.length>4000)throw Object.assign(Error('invalid_translation'),{code:'invalid_translation'});
    return translated;
  }

  snapshot() {
    const graph = this.graph.snapshot();
    const latest = graph.nodes.find(node=>node.id===this.lastNodeId);
    const activeTool = [...this.tools.values()].at(-1);
    const message = this.issue || (activeTool ? `正在调用 ${activeTool.name}${activeTool.object ? '：'+activeTool.object : ''}` :
      latest ? latest.cancelled ? '本次尝试已中断' : latest.text :
      this.running ? (this.busy ? '正在整理任务进度' : '正在分析任务，等待完整段落') :
      this.stats.segments ? '本轮已结束，尚无可展示的新进展' : '等待任务开始');
    return { presentation:'stage-summary-v3',sessionId:this.sessionId,turn:this.turn, summaryMode:this.summaryMode,appearance:this.appearance,summaryAppearance:this.summaryAppearance,showStatusBar:this.showStatusBar,flowDirection:this.flowDirection,outputPolicy:{...this.outputPolicy},title:this.title, taskGoal:this.taskGoal,goalSeq:this.goalSeq,
      running:this.running, busy:this.busy||this.refinements.size>0,
      pending:this.queue.length, pendingReports:this.reports.pending.size,
      issue:this.issue, lastActivity:this.lastActivity, lastProgress:this.lastProgress, message, graph,
      latestPhase:latest?PHASE_LABELS[latest.phase]:'等待进展', latestIntent:latest?INTENT_LABELS[latest.intent]:'',
      messages:this.messages.map(message=>({...message,parts:message.parts?.map(part=>({...part}))})),
      nodeSequence:this.graph.nodeSequence,messageSequence:this.reports.sequence,
      lightUsage:this.lightUsage.snapshot(),
      jevUsage:this.jevUsage.snapshot(),
      stats:{...this.stats,endToEndMs:[...this.stats.endToEndMs]} };
  }

  async settle({ timeoutMs = 30000 } = {}) {
    const start = Date.now();
    while (!this.disposed && (this.busy || this.queue.length || this.refinements.size)) {
      if (Date.now()-start >= timeoutMs) throw Error('progress_settle_timeout');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  }
  dispose() {
    this.disposed = true;
    this.running = false;
    this.controller.abort();
    this.cancelPending(false);
    this.reports.dispose();
  }
}
