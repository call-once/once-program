/* Consecutive funded puts fit one transaction, including the budget instructions and signature. */
import { test, expect } from 'vitest';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import * as once from '../client/src/generated/index.js';
import { Harness, LOT, STRIKE, PREMIUM } from './harness.js';
import { TOKEN, XSTOCKS } from '../client/constants.js';
const P = once.ONCE_PROGRAM_ADDRESS, enc = getAddressEncoder();
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
test('write_put count per transaction', async () => {
  const h = await Harness.create({ gated: true });
  const mint = h.svm.getAccount(XSTOCKS.NVDAx); if (!mint.exists) throw new Error('Missing mint');
  const tp = mint.programAddress;
  for (let n = 1; n <= 5; n++) {
    const start = h.configState().nextId, ixs = [];
    for (let i = 0n; i < BigInt(n); i++) {
      const id = start + i, put = (await getProgramDerivedAddress({ programAddress: P, seeds: ['put', u64(id)] }))[0];
      const vault = (await getProgramDerivedAddress({ programAddress: P, seeds: ['put_vault', enc.encode(put)] }))[0];
      ixs.push(once.getWritePutInstruction({ config: h.config, writer: h.writer, put, vault, mint: XSTOCKS.NVDAx, tokenProgram: tp, usdcMint: h.usdc,
        usdcTokenProgram: TOKEN, source: h.writerUsdc, id, lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: 2000n, ...h.eventAccounts() }));
    }
    ixs.unshift({programAddress: address('ComputeBudget111111111111111111111111111111'), data:new Uint8Array([2,192,92,21,0])},
      {programAddress: address('ComputeBudget111111111111111111111111111111'),data:new Uint8Array([3,0,0,0,0,0,0,0,0])});
    const tx = await h.transaction(ixs, h.writer);
    const bytes = 1 + 64 * Object.keys(tx.signatures).length + tx.messageBytes.length;
    expect(bytes).toBeLessThanOrEqual(1232);
    const r = await h.send(`write_put x${n}`, ixs, h.writer), cu=String(r.computeUnitsConsumed());
    expect(h.configState().nextId).toBe(start+BigInt(n));
    console.log(JSON.stringify({ n, bytes, cu }));
  }
});
