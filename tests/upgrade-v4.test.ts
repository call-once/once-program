/* Accounts made by the preceding executable keep working after replacement. */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getAddressEncoder, getProgramDerivedAddress, generateKeyPairSigner, unwrapOption, type ReadonlyUint8Array } from '@solana/kit';
import * as once from '../client/src/generated/index.js';
import { Harness, amount, ata, LOT, STRIKE, PREMIUM } from './harness.js';
import { LOADER, TOKEN, USDC, XSTOCKS } from '../client/constants.js';

const V4 = process.env.ONCE_PREV_SO!, P = once.ONCE_PROGRAM_ADDRESS, enc = getAddressEncoder();
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const pda = async (...s: (string | ReadonlyUint8Array)[]) => (await getProgramDerivedAddress({ programAddress: P, seeds: s }))[0];

test.skipIf(!V4)('previous Config, calls, locks, listings and resale locks keep working after the put binary replaces it', async () => {
  expect(execFileSync('solana-verify', ['get-executable-hash', V4], { encoding: 'utf8' }).trim()).toBe('4b49e2b75b8cf3ad8966f00e37fdb8787ac1e72dee8d2e4d0280dc41ec035218');
  const h = await Harness.create({ gated: true, binary: pathToFileURL(V4) });
  const held = await h.write(), gated = await h.write(), resold = await h.write(), open = await h.write();
  await h.send('lock_and_buy (v4)', h.lockBuyIx(gated), h.buyer);
  const next = await generateKeyPairSigner();
  h.svm.airdrop(next.address, 10_000_000_000n as any);
  const nextUsdc = await h.fundToken(next, USDC, TOKEN, 10_000_000n), nextOnce = await h.fundToken(next, h.onceMint, h.onceProgram, 10_000_000n);
  // resold: bought inside its gate, offered inside it, and bought from its holder inside it: a v4 ResaleLock
  await h.send('lock_and_buy (v4, resold)', h.lockBuyIx(resold), h.buyer);
  const rListing = await pda('listing', enc.encode(resold.call));
  await h.send('list inside the gate (v4)', once.getListInstruction({ holder: h.buyer, call: resold.call, listing: rListing, price: 5n, ...h.eventAccounts() }), h.buyer);
  const resaleLock = await pda('resale_lock', enc.encode(resold.call), enc.encode(next.address)), resaleVault = await pda('resale_lock_vault', enc.encode(resold.call), enc.encode(next.address));
  await h.send('lock_and_buy_listed (v4)', once.getLockAndBuyListedInstruction({ buyer: next, config: h.config, call: resold.call, listing: rListing, seller: h.buyer.address,
    lock: resaleLock, lockVault: resaleVault, onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: nextOnce, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
    paymentSource: nextUsdc, paymentDestination: h.buyerUsdc, price: 5n, ...h.eventAccounts() }), next);
  expect(h.svm.getAccount(resaleLock).exists).toBe(true);
  h.slot(h.callState(held).gateUntil);
  await h.send('buy (v4)', h.buyIx(held), h.buyer);
  const listing = await pda('listing', enc.encode(held.call));
  await h.send('list (v4)', once.getListInstruction({ holder: h.buyer, call: held.call, listing, price: 7n, ...h.eventAccounts() }), h.buyer);
  // a put instruction does not exist in v4
  const put0 = await pda('put', u64(4n));
  const writePut = (id: bigint, put: string, vault: string) => once.getWritePutInstruction({ config: h.config, writer: h.writer, put: put as any, vault: vault as any,
    mint: XSTOCKS.NVDAx, tokenProgram: open.tokenProgram, usdcMint: h.usdc, usdcTokenProgram: TOKEN, source: h.writerUsdc, id, lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: 2000n, ...h.eventAccounts() });
  await h.send('write_put unavailable in v4', writePut(4n, put0, await pda('put_vault', enc.encode(put0))), h.writer, '');
  // replace the executable at the same address and keep the upgrade authority
  const pd = h.svm.getAccount(h.programData) as any, authority = Buffer.from(pd.data).subarray(12, 45);
  h.svm.addProgramWithLoader(P, readFileSync(new URL('../target/deploy/once.so', import.meta.url)), LOADER);
  const pd2 = h.svm.getAccount(h.programData) as any, d2 = Buffer.from(pd2.data); d2.set(authority, 12); h.svm.setAccount({ ...pd2, data: d2 });
  expect(h.configState().nextId).toBe(4n);
  await h.send('buy_listed after replacement (v4 listing)', once.getBuyListedInstruction({ buyer: next, config: h.config, call: held.call, listing, seller: h.buyer.address,
    usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: nextUsdc, paymentDestination: h.buyerUsdc, price: 7n, ...h.eventAccounts() }), next);
  expect(unwrapOption(h.callState(held).holder)).toBe(next.address);
  h.slot(h.callState(gated).gateUntil);
  await h.send('return_lock after replacement (v4 lock)', h.returnIx(gated), h.buyer);
  const o0 = amount(h.svm, nextOnce);
  await h.send('return_resale_lock after replacement (v4 resale lock)', once.getReturnResaleLockInstruction({ locker: next, config: h.config, lock: resaleLock, lockVault: resaleVault,
    onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: nextOnce, ...h.eventAccounts() }), next);
  expect(amount(h.svm, nextOnce) - o0).toBe(h.configState().lockAmount);
  await h.send('return_lock after replacement (v4 lock, resold)', h.returnIx(resold), h.buyer);
  await h.send('cancel after replacement (v4 open call)', h.cancelIx(open), h.writer);
  await h.send('call after replacement (v4 held call)', await h.callIx(gated), h.buyer);
  await h.send('write_put after replacement', writePut(4n, put0, await pda('put_vault', enc.encode(put0))), h.writer);
  expect(h.configState().nextId).toBe(5n);
  const c5 = await h.write();
  expect(c5.id).toBe(5n);
  void ata;
});
