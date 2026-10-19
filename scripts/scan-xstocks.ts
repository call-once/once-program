import { writeFileSync } from 'node:fs';
import { address } from '@solana/kit';
import { inspectMint } from '../client/mint.js';
import { MAINNET_RPC, rpc } from './rpc.js';

const assets = new Map<string, string>();
let pages = 0;
for (let page = 0; ; page++) {
  const response = await fetch(`https://api.xstocks.fi/api/v2/public/assets?page=${page}`);
  if (!response.ok) throw new Error(`Assets API: HTTP ${response.status}`);
  const body = await response.json() as { nodes: { symbol: string; deployments: { network: string; address: string }[] }[]; page: { totalPages?: number; hasNextPage?: boolean } };
  if (!Array.isArray(body.nodes)) throw new Error('Invalid assets page');
  if (body.nodes.length === 0) break;
  pages++;
  for (const asset of body.nodes) for (const deployment of asset.deployments) {
    if (deployment.network === 'Solana') assets.set(address(deployment.address), asset.symbol);
  }
  if (body.page.totalPages !== undefined && page + 1 >= body.page.totalPages) break;
  if (body.page.hasNextPage === false) break;
  if (page > 1000) throw new Error('Pagination did not terminate');
}
const entries = [...assets];
const rows = [];
const slots: number[] = [];
for (let offset = 0; offset < entries.length; offset += 100) {
  const chunk = entries.slice(offset, offset + 100);
  const result = await rpc(MAINNET_RPC, 'getMultipleAccounts', [chunk.map(([a]) => a), { encoding: 'base64', commitment: 'confirmed' }]);
  slots.push(result.context.slot);
  rows.push(...chunk.map(([mint, symbol], index) => {
    const a = result.value[index];
    const inspected = a ? inspectMint(address(a.owner), Buffer.from(a.data[0], 'base64')) : { valid: false, failures: ['MissingMint'], extensions: [] };
    return { mint, symbol, slot: result.context.slot, ...inspected };
  }));
  await new Promise(r => setTimeout(r, 350));
}
const combinations: Record<string, number> = {};
for (const row of rows) {
  const key = row.extensions.join(',');
  combinations[key] = (combinations[key] ?? 0) + 1;
}
const report = { pages, addresses: assets.size, slots, passed: rows.filter(r => r.valid).length,
  failed: rows.filter(r => !r.valid), extensionCombinations: combinations, rows };
writeFileSync(new URL('../tests/fixtures/xstocks-scan.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
