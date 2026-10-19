import { scriptEndpoints, withoutEndpoint, type Fallback } from './rpc-fallback.js';
export const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
export const DEVNET_RPC = 'https://api.devnet.solana.com';

export async function rpc<T = any>(url: string, method: string, params: unknown[] = [], options?: Fallback): Promise<T> {
  if (options?.fallback) return scriptEndpoints(url, options).call<T>(method, params);
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(20000), method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (response.status === 429) {
        await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
      const body = await response.json() as { result: T; error?: unknown };
      if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    }
    throw new Error(`RPC ${method}: rate limit after retries`);
  } catch (error) { throw new Error(withoutEndpoint(error instanceof Error ? error.message : String(error), url)); }
}
