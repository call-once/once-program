/* Shared JSON-RPC endpoint selection. No endpoint is included in an error or log. */
export const DETERMINISTIC = new Set([-32600, -32602, -32002, -32003, -32006, -32013, -32015]);
export type Fallback = { fallback: string; genesis: string };
export const withoutEndpoint = (message: string, url: string) =>
  message.replaceAll(url, '[endpoint]').replace(/https?:\/\/[^\s"'\\]+/g, '[endpoint]');
export class RpcFault extends Error {
  constructor(message: string, readonly kind: 'network' | 'rpc' | 'genesis', readonly code?: number,
    readonly data?: unknown, readonly alreadyProcessed = false, readonly retryMs = 10000) { super(message); }
}
type Options = {
  fetch?: typeof fetch; now?: () => number; holds?: Map<string, number>;
  primaryMs?: number; fallbackMs?: number;
  mismatch?: 'throw' | 'disable' | 'disable-fallback';
  onDisable?: () => void;
};
type State = { verified: boolean; disabled: boolean; pending?: Promise<void> };

export class RpcEndpoints {
  private states = new Map<string, State>();
  private holds: Map<string, number>;
  private now: () => number;
  readonly fallback: string | undefined;
  constructor(readonly primary: string, fallback: string | null | undefined, readonly genesis: string, private opts: Options = {}) {
    this.fallback = fallback && fallback !== primary ? fallback : undefined;
    this.holds = opts.holds ?? new Map();
    this.now = opts.now ?? Date.now;
  }
  private state(url: string) {
    let state = this.states.get(url);
    if (!state) this.states.set(url, state = { verified: false, disabled: false });
    return state;
  }
  get unusable() { return [this.primary, this.fallback].filter((u): u is string => !!u).every(u => this.state(u).disabled); }
  private async request<T>(url: string, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) ctl.abort();
    const ms = url === this.primary ? (this.opts.primaryMs ?? 8000) : (this.opts.fallbackMs ?? 15000);
    const timer = setTimeout(abort, ms);
    let stop: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(new RpcFault(`RPC ${method}: no response`, 'network'));
      ctl.signal.addEventListener('abort', stop, { once: true });
      if (ctl.signal.aborted) stop();
    });
    const fetchBody = async () => {
      let res: Response;
      try {
        res = await (this.opts.fetch ?? globalThis.fetch)(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
      } catch { throw new RpcFault(`RPC ${method}: no response`, 'network'); }
      const header = res.headers.get('retry-after')?.trim() || null;
      const seconds = header === null ? NaN : Number(header);
      const retryMs = header === null ? 10000 : Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000 : Math.max(0, Date.parse(header) - this.now());
      const wait = Number.isFinite(retryMs) ? retryMs : 10000;
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new RpcFault(`RPC ${method}: HTTP ${res.status}`, 'network', undefined, undefined, false, wait);
      }
      let body: any;
      try { body = await res.json(); }
      catch { throw new RpcFault(`RPC ${method}: unreadable answer`, 'network', undefined, undefined, false, wait); }
      if (!body || typeof body !== 'object') throw new RpcFault(`RPC ${method}: no result`, 'network', undefined, undefined, false, wait);
      if (body.error) {
        const code = typeof body.error.code === 'number' ? body.error.code : undefined;
        throw new RpcFault(`RPC ${method}: error ${code ?? '?'}`, code !== undefined && DETERMINISTIC.has(code) ? 'rpc' : 'network',
          code, body.error.data, /AlreadyProcessed/.test(JSON.stringify(body.error)), wait);
      }
      if (!('result' in body)) throw new RpcFault(`RPC ${method}: no result`, 'network', undefined, undefined, false, wait);
      return body.result as T;
    };
    try { return await Promise.race([fetchBody(), stopped]); }
    finally {
      clearTimeout(timer);
      ctl.signal.removeEventListener('abort', stop);
      signal?.removeEventListener('abort', abort);
      ctl.abort();
    }
  }
  private async checked(url: string, signal?: AbortSignal) {
    const state = this.state(url);
    if (state.disabled) throw new RpcFault('RPC is not on the configured cluster', 'genesis');
    if (state.verified) return;
    state.pending ??= this.request<string>(url, 'getGenesisHash', [], signal).then(hash => {
      if (hash !== this.genesis) {
        state.disabled = true;
        if (url === this.fallback && this.opts.mismatch === 'disable-fallback') this.opts.onDisable?.();
        throw new RpcFault('Genesis mismatch', 'genesis');
      }
      state.verified = true;
    }).finally(() => { state.pending = undefined; });
    await state.pending;
  }
  async call<T>(method: string, params: unknown[] = [], signal?: AbortSignal, singleSend = false): Promise<T> {
    let last = new RpcFault(`RPC ${method}: temporarily unavailable`, 'network');
    for (const url of [this.primary, this.fallback].filter((u): u is string => !!u)) {
      const state = this.state(url);
      if (state.disabled) {
        if (this.opts.mismatch === 'throw' || (this.opts.mismatch !== 'disable' && url === this.primary))
          throw new RpcFault('Genesis mismatch', 'genesis');
        continue;
      }
      if ((this.holds.get(url) ?? 0) > this.now()) continue;
      try {
        await this.checked(url, signal);
        if (signal?.aborted) throw new RpcFault(`RPC ${method}: no response`, 'network');
        return method === 'getGenesisHash' ? this.genesis as T : await this.request<T>(url, method, params, signal);
      } catch (error) {
        const fault = error instanceof RpcFault ? error : new RpcFault(`RPC ${method}: no response`, 'network');
        if (fault.kind === 'rpc') throw fault;
        if (fault.kind === 'genesis') {
          if (this.opts.mismatch === 'throw' || (this.opts.mismatch !== 'disable' && url === this.primary)) throw fault;
          last = new RpcFault(`RPC ${method}: no usable endpoint`, 'network');
          continue;
        }
        this.holds.set(url, Math.max(this.holds.get(url) ?? 0, this.now() + fault.retryMs));
        last = fault;
        if (signal?.aborted || (singleSend && method === 'sendTransaction')) throw fault;
      }
    }
    throw last;
  }
}

/* Script helpers cache per process, per transport, per endpoint pair and expected cluster. */
const pools = new WeakMap<typeof fetch, Map<string, RpcEndpoints>>();
const processHolds = new WeakMap<typeof fetch, Map<string, number>>();
export function scriptEndpoints(url: string, options: Fallback) {
  let cache = pools.get(globalThis.fetch);
  if (!cache) pools.set(globalThis.fetch, cache = new Map());
  const key = JSON.stringify([url, options.fallback, options.genesis]);
  let pool = cache.get(key);
  let holds = processHolds.get(globalThis.fetch);
  if (!holds) processHolds.set(globalThis.fetch, holds = new Map());
  if (!pool) cache.set(key, pool = new RpcEndpoints(url, options.fallback, options.genesis, { holds, primaryMs: 20000, fallbackMs: 20000, mismatch: 'throw' }));
  return pool;
}
