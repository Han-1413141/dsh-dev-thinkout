const normalized=text=>String(text??'').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const rank={planned:0,active:1,reported_done:2};

/** Turn-wide deduplication and phase updates; never model context. */
export class ProgressReports {
  constructor({now=Date.now,onPublish=()=>{}}={}) {
    Object.assign(this,{now,onPublish,messages:[],pending:new Map(),latest:new Map(),
      sequence:0,coalesced:0,suppressed:0,summaryGoals:new Set(),disposed:false});
  }
  key(update){return `${update.goalSeq??'goal'}:${update.turn??''}:${update.activity??update.text}`;}
  stage(update){return update.phase||'other';}
  signature(update){return `${update.intent}:${normalized(update.text)}`;}
  hasTaskSummary(goalSeq){return this.summaryGoals.has(goalSeq);}
  setTaskSummary({goalSeq,turn,text,sourceAt,step}) {
    if(this.disposed||this.hasTaskSummary(goalSeq))return;
    this.summaryGoals.add(goalSeq);
    while(this.summaryGoals.size>64)this.summaryGoals.delete(this.summaryGoals.values().next().value);
    const summary={id:`summary-${++this.sequence}`,kind:'task_summary',goalSeq,turn,step,sourceAt,at:this.now(),text};
    this.messages.push(summary);this.trim();this.onPublish(summary,[{sourceAt}]);
  }
  has(update) {
    const previous=this.latest.get(this.key(update));
    if(!previous)return false;
    if(update.intent==='planned'&&previous.intent!=='planned')return true;
    if(previous.intent==='reported_done'&&update.intent==='active'&&update.relation!=='revise')return true;
    if(update.relation==='revise'&&update.novel&&update.step!==previous.step)return false;
    return previous.intent===update.intent;
  }
  canSummarize(update) {return ['plan','summary','milestone'].includes(update.updateKind)&&update.novel===true;}
  offer(updates) {
    if(this.disposed)return;
    for(const update of updates) {
      if(!this.has(update))this.publishProgress(update);
      else this.suppressed++;
      if(update.summary&&this.canSummarize(update))this.publishSummary(update);
    }
  }
  publishProgress(update) {
    const sameText=this.messages.find(message=>message.kind==='progress'&&!message.cancelled&&
      message.goalSeq===update.goalSeq&&message.turn===update.turn&&normalized(message.text)===normalized(update.text));
    const sameActivity=this.messages.find(message=>message.kind==='progress'&&!message.cancelled&&
      message.parts?.some(part=>this.key(part)===this.key(update)));
    const samePhase=this.messages.find(message=>message.kind==='progress'&&!message.cancelled&&
      message.goalSeq===update.goalSeq&&message.turn===update.turn&&message.stage===this.stage(update));
    const existing=sameActivity??sameText??samePhase;
    const parts=new Map((existing?.parts??[]).map(part=>[this.key(part),part]));
    parts.set(this.key(update),{...update});
    const report={...update,id:existing?.id??`progress-${++this.sequence}`,kind:'progress',
      at:this.now(),stage:this.stage(update),parts:[...parts.values()].slice(-12)};
    if(existing){this.messages[this.messages.indexOf(existing)]=report;this.coalesced++;}
    else this.messages.push(report);
    this.latest.set(this.key(update),{...update});
    this.trim();this.onPublish(report,[update]);
  }
  publishSummary(update) {
    const text=String(update.summary).trim();
    if(!text||this.messages.some(message=>!message.cancelled&&message.goalSeq===update.goalSeq&&
      normalized(message.text)===normalized(text)))return;
    const kind=update.updateKind==='plan'?'plan_summary':'stage_summary';
    const previous=this.messages.find(message=>!message.cancelled&&message.kind===kind&&
      message.goalSeq===update.goalSeq&&message.turn===update.turn&&message.phase===update.phase&&
      message.step===update.step&&message.attemptId===update.attemptId&&
      (kind==='plan_summary'||message.blockIndex===update.blockIndex&&
        (Number.isFinite(update.sourceOffset)?message.sourceOffset===update.sourceOffset:message.sourceAt===update.sourceAt)));
    const report={id:previous?.id??`recap-${++this.sequence}`,kind,text,phase:update.phase,
      nodeId:update.nodeId,previousNodeId:update.previousNodeId,relation:update.relation,taskId:update.taskId,activity:update.activity,intent:update.intent,workItem:update.workItem??'',
      turn:update.turn,step:update.step,goalSeq:update.goalSeq,at:this.now(),sourceAt:update.sourceAt,
      attemptId:update.attemptId,blockIndex:update.blockIndex,sourceOffset:update.sourceOffset};
    if(previous){this.messages[this.messages.indexOf(previous)]=report;this.coalesced++;}
    else this.messages.push(report);
    this.trim();this.onPublish(report,[update]);
  }
  refine(update) {
    const previous=this.latest.get(this.key(update));
    if(!previous)return;
    const message=this.messages.find(entry=>entry.kind==='progress'&&!entry.cancelled&&
      entry.parts?.some(part=>this.key(part)===this.key(update)));
    if(message&&update.refineStatus!==false&&previous.intent===update.intent) {
      message.parts=message.parts.map(part=>this.key(part)===this.key(update)?{...part,...update}:part);
      if(this.key(message)===this.key(update))Object.assign(message,{text:update.text,at:this.now()});
      this.latest.set(this.key(update),{...previous,...update});
      this.onPublish(message,[]);
    }
    if(update.summary&&this.canSummarize(update))this.publishSummary(update);
  }
  trim() {
    this.messages=this.messages.slice(-200);
    while(this.latest.size>100)this.latest.delete(this.latest.keys().next().value);
  }
  flush(){}
  clearPending(){this.pending.clear();}
  reconcile(updates) {
    for(const update of updates) {
      const previous=this.latest.get(this.key(update));
      if(!previous||update.intent==='planned'||(rank[update.intent]??-1)<(rank[previous.intent]??-1))continue;
      this.publishProgress({...previous,...update,step:previous.step,
        blockIndex:previous.blockIndex,sourceOffset:previous.sourceOffset});
    }
  }
  cancel(attemptId) {
    for(const [key,update] of this.latest)if(update.attemptId===attemptId)this.latest.delete(key);
    for(const message of this.messages) {
      if(message.parts?.some(part=>part.attemptId===attemptId)) {
        const remaining=message.parts.filter(part=>part.attemptId!==attemptId);
        if(!remaining.length){message.cancelled=true;continue;}
        Object.assign(message,remaining.at(-1),{parts:remaining});
      } else if(message.attemptId===attemptId)message.cancelled=true;
    }
  }
  restore(messages,sequence=0) {
    this.messages=messages.slice(-200);
    this.sequence=Math.max(this.messages.length,Number(sequence)||0);
    for(const message of this.messages) {
      if(message.kind==='task_summary')this.summaryGoals.add(message.goalSeq);
      if(!message.cancelled)for(const part of message.parts??[])this.latest.set(this.key(part),part);
    }
    this.trim();
  }
  dispose(){this.disposed=true;this.clearPending();}
}
