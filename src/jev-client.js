import { randomUUID } from 'node:crypto';
export const JEV_FREE_PRICING=Object.freeze({kind:'free',source:'https://decision.vllm-sr.ai/docs',fetchedAt:Date.parse('2026-10-21T00:00:00+08:00')});
export class JevError extends Error {
  constructor(code, retryAfterMs = 0) { super(code); this.name = 'JevError'; this.code = code; this.retryAfterMs = retryAfterMs; }
}

export class JevClient {
  constructor({ apiKey, fetchImpl = fetch, timeoutMs = 8000, maxConcurrent = 2, onUsage=()=>{} } = {}) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.onUsage=onUsage;
    this.active = 0;
    this.waiters = [];
    this.cooldownUntil = 0;
    this.metrics = { requests: 0, failures: 0, inputTokens: 0, latencyMs: [] };
  }

  async acquire(signal) {
    if (signal?.aborted) throw new JevError('cancelled');
    if (this.active < this.maxConcurrent) { this.active++; return; }
    if (this.waiters.length >= 24) throw new JevError('queue_full');
    await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { this.waiters = this.waiters.filter(w => w !== waiter); reject(new JevError('cancelled')); };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  release() { const next = this.waiters.shift(); if (next) next.resolve(); else this.active--; }

  async decide(payload, signal, context={}) {
    if (!this.apiKey) throw new JevError('missing_key');
    if (Date.now() < this.cooldownUntil) throw new JevError('rate_limited', this.cooldownUntil - Date.now());
    await this.acquire(signal);
    const started = performance.now();
    const at=Date.now(),id=randomUUID();let dispatched=false,usage=null,outcome='failed',errorCode;
    try {
      if (signal?.aborted) throw new JevError('cancelled');
      if (Date.now() < this.cooldownUntil) throw new JevError('rate_limited', this.cooldownUntil - Date.now());
      this.metrics.requests++;
      dispatched=true;
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await this.fetch('https://decision.vllm-sr.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, model: 'vllm-sr/d3-turbo' }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const raw = response.headers.get('retry-after');
        const seconds = Number(raw);
        const delay = raw === null ? 1000 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
        if (response.status === 429 || response.status === 503)
          this.cooldownUntil = Date.now() + Math.max(1000, Math.min(Number.isFinite(delay) ? delay : 1000, 120000));
        throw new JevError(`http_${response.status}`, Math.max(0, this.cooldownUntil - Date.now()));
      }
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 256000) { await reader.cancel(); throw new JevError('response_too_large'); }
            chunks.push(value);
          }
          text = Buffer.concat(chunks).toString('utf8');
        } finally { reader.releaseLock(); }
      } else {
        text = await response.text();
        if (text.length > 256000) throw new JevError('response_too_large');
      }
      let data; try { data = JSON.parse(text); } catch { throw new JevError('invalid_json'); }
      if(Number.isSafeInteger(data.usage?.input_tokens)&&data.usage.input_tokens>=0)
        usage={inputTokens:data.usage.input_tokens,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0};
      if (data.model !== 'vllm-sr/d3-turbo' || !data.answers) throw new JevError('invalid_response');
      const elapsed = performance.now() - started;
      this.metrics.inputTokens += Number.isFinite(data.usage?.input_tokens) ? data.usage.input_tokens : 0;
      this.metrics.latencyMs.push(elapsed);
      if (this.metrics.latencyMs.length > 500) this.metrics.latencyMs.shift();
      outcome='ok';return { data, elapsedMs: elapsed };
    } catch (error) {
      this.metrics.failures++;
      const failure=error instanceof JevError ? error : new JevError(signal?.aborted ? 'cancelled' : error?.name === 'TimeoutError' ? 'timeout' : 'network_error');
      errorCode=failure.code;if(errorCode==='cancelled')outcome='cancelled';throw failure;
    } finally {
      this.release();
      if(dispatched)try {this.onUsage({...context,id,at,elapsedMs:performance.now()-started,
        provider:'jev',model:'vllm-sr/d3-turbo',usage,outcome,errorCode,pricing:JEV_FREE_PRICING});}catch{}
    }
  }
}
