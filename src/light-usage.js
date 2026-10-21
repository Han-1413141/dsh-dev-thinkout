import { randomUUID } from 'node:crypto';
const nonnegative=value=>Number.isSafeInteger(value)&&value>=0;
export function normalizeUsage(value) {
  if(!value||!nonnegative(value.inputTokens)||!nonnegative(value.outputTokens))return null;
  const result={inputTokens:value.inputTokens,outputTokens:value.outputTokens};
  for(const key of ['cacheReadTokens','cacheWriteTokens'])
    result[key]=nonnegative(value[key])?value[key]:0;
  result.totalTokens=Object.values(result).reduce((a,b)=>a+b,0);
  return result;
}
function validTier(tier) {
  return tier&&['cacheMiss','cacheHit','output'].every(key=>Number.isFinite(tier[key])&&tier[key]>=0);
}
export function estimateUsage(usage,pricing) {
  if(pricing?.kind==='free'&&typeof pricing.source==='string')return {currency:'USD',low:0,high:0,kind:'free',source:pricing.source,fetchedAt:pricing.fetchedAt};
  if(!usage||!pricing||!['CNY','USD'].includes(pricing.currency))return null;
  const tiers=[pricing.entry?.offPeak??pricing.entry,pricing.entry?.peak??pricing.entry].filter(validTier);
  if(!tiers.length)return null;
  const costs=tiers.map(tier=>(usage.inputTokens*tier.cacheMiss+usage.outputTokens*tier.output+
    usage.cacheReadTokens*tier.cacheHit+usage.cacheWriteTokens*(tier.cacheWrite??tier.cacheHit))/1e6);
  return {currency:pricing.currency,low:Math.min(...costs),high:Math.max(...costs),
    source:pricing.source??'DSH 当前价格目录',fetchedAt:pricing.fetchedAt};
}
/** Usage is recorded even when an auxiliary result is cancelled or discarded. */
export class LightUsage {
  constructor(model='deepseek-flash') {
    this.model=model;
    this.state={since:Date.now(),calls:0,successful:0,cancelled:0,failed:0,missingUsage:0,
      inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0,
      pricedCalls:0,costs:{},records:[]};
  }
  add(record) {
    const state=this.state,usage=normalizeUsage(record.usage),estimate=estimateUsage(usage,record.pricing);
    state.calls++;
    state[record.outcome==='ok'?'successful':record.outcome==='cancelled'?'cancelled':'failed']++;
    if(usage)for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens'])state[key]+=usage[key];
    else state.missingUsage++;
    if(estimate) {
      state.pricedCalls++;
      const sum=state.costs[estimate.currency]??={low:0,high:0};
      sum.low+=estimate.low;sum.high+=estimate.high;
    }
    const saved={id:record.id??randomUUID(),at:record.at,elapsedMs:record.elapsedMs,outcome:record.outcome,
      provider:record.provider,model:record.model??this.model,turn:record.turn??null,step:record.step??null,usage,estimate,
      ...(record.errorCode?{errorCode:record.errorCode}:{}),
      metering:record.metering??'local'};
    state.records.push(saved);
    state.records=state.records.slice(-100);
    return saved;
  }
  restore(value) {
    if(!value||!nonnegative(value.calls)||!Array.isArray(value.records))return;
    const clean=this.state;
    for(const key of Object.keys(clean))if(typeof clean[key]==='number'&&nonnegative(value[key]))clean[key]=value[key];
    for(const currency of ['CNY','USD']) {
      const cost=value.costs?.[currency];
      if(cost&&Number.isFinite(cost.low)&&cost.low>=0&&Number.isFinite(cost.high)&&cost.high>=cost.low)
        clean.costs[currency]={low:cost.low,high:cost.high};
    }
    clean.records=value.records.slice(-100);
  }
  snapshot(){return structuredClone(this.state);}
}

/** Optional read-only integration with the existing DSH cost plugin. */
export function createPricingReader(getService) {
  let cached=null,until=0;
  return async()=>{
    if(Date.now()<until)return cached;
    const service=getService();
    if(typeof service?.getPriceCatalog!=='function'||typeof service?.getLocalState!=='function')return null;
    let timer;
    try {
      const [catalog,state]=await Promise.race([
        Promise.all([service.getPriceCatalog(),service.getLocalState()]),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('pricing_timeout')),1200);}),
      ]);
      const currency=state?.config?.prices?.currency;
      const entry=Object.values(catalog?.deepseek??{}).map(group=>group?.['deepseek-flash']).find(Boolean);
      cached=['CNY','USD'].includes(currency)&&entry?{
        currency,entry,source:'DSH 当前价格目录（谷价至峰价估算）',fetchedAt:Date.now(),
      }:null;
      until=Date.now()+60000;return cached;
    } catch {until=Date.now()+10000;return cached;}
    finally {clearTimeout(timer);}
  };
}

/** Sum retained local display ledgers without replaying or inventing usage. */
export function combineUsage(values) {
 const combined=new LightUsage().snapshot();combined.records=[];
 for(const value of values.filter(Boolean)){
  for(const key of Object.keys(combined))if(key!=='since'&&typeof combined[key]==='number'&&nonnegative(value[key]))combined[key]+=value[key];
  for(const [currency,cost]of Object.entries(value.costs??{}))if(['CNY','USD'].includes(currency)&&Number.isFinite(cost.low)&&Number.isFinite(cost.high)){
    const target=combined.costs[currency]??={low:0,high:0};target.low+=cost.low;target.high+=cost.high;
  }
 }
 return combined;
}
