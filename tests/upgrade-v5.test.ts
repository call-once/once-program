/* Accounts made by the deployed executable keep working after the exit binary replaces it. */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getAddressEncoder, getProgramDerivedAddress, generateKeyPairSigner, unwrapOption, type Address, type ReadonlyUint8Array } from '@solana/kit';
import * as once from '../client/src/generated/index.js';
import { Harness, amount, LOT, STRIKE, PREMIUM } from './harness.js';
import { LOADER, TOKEN, XSTOCKS } from '../client/constants.js';
import { findLockPda, findLockVaultPda, findListingPda } from '../client/pdas.js';

const V5 = process.env.ONCE_PREV_SO!, P = once.ONCE_PROGRAM_ADDRESS, enc = getAddressEncoder();
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const pda = async (...s: (string | ReadonlyUint8Array)[]) => (await getProgramDerivedAddress({ programAddress: P, seeds: s }))[0];

test.skipIf(!V5)('Config, calls, puts, locks and listings from the deployed binary keep working after the exit binary replaces it', async () => {
  expect(execFileSync('solana-verify', ['get-executable-hash', V5], { encoding: 'utf8' }).trim()).toBe('e476e64f69f109e3e811273ed9bee7e753073e83bd7ed8be621bee1e7866984d');
  const h = await Harness.create({ gated: true, binary: pathToFileURL(V5) });
  const ev = h.eventAccounts();
  const call = await h.write(), openCall = await h.write();
  const putAt = async (id: bigint) => { const put = await pda('put', u64(id)); return { put, vault: await pda('put_vault', enc.encode(put)) }; };
  const writePut = async (id: bigint) => { const p = await putAt(id); await h.send(`write_put ${id} (v5)`, once.getWritePutInstruction({ config: h.config, writer: h.writer, ...p,
    mint: XSTOCKS.NVDAx, tokenProgram: call.tokenProgram, usdcMint: h.usdc, usdcTokenProgram: TOKEN, source: h.writerUsdc, id, lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: 2000n, ...ev }), h.writer); return p; };
  const gatedPut = await writePut(2n), heldPut = await writePut(3n), openPut = await writePut(4n);
  const putLock = (await findLockPda(gatedPut.put))[0], putLockVault = (await findLockVaultPda(gatedPut.put))[0];
  await h.send('lock_and_buy_put (v5)', once.getLockAndBuyPutInstruction({ config: h.config, put: gatedPut.put, buyer: h.buyer, lock: putLock, lockVault: putLockVault,
    onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: h.buyerOnce, vault: gatedPut.vault, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
    paymentSource: h.buyerUsdc, paymentDestination: h.writerUsdc, ...ev }), h.buyer);
  // a call bought inside its gate, offered inside it and bought from its holder inside it: a v5 Lock and a v5 ResaleLock
  const resold = await h.write();
  await h.send('lock_and_buy (v5, resold)', h.lockBuyIx(resold), h.buyer);
  const rListing = (await findListingPda(resold.call))[0];
  await h.send('list inside the gate (v5)', once.getListInstruction({ holder: h.buyer, call: resold.call, listing: rListing, price: 5n, ...ev }), h.buyer);
  const other = await generateKeyPairSigner();
  h.svm.airdrop(other.address, 10_000_000_000n as any);
  const otherUsdc = await h.fundToken(other, h.usdc, TOKEN, 10_000_000n), otherOnce = await h.fundToken(other, h.onceMint, h.onceProgram, 10_000_000n);
  const resaleLock = await pda('resale_lock', enc.encode(resold.call), enc.encode(other.address)), resaleVault = await pda('resale_lock_vault', enc.encode(resold.call), enc.encode(other.address));
  await h.send('lock_and_buy_listed (v5)', once.getLockAndBuyListedInstruction({ buyer: other, config: h.config, call: resold.call, listing: rListing, seller: h.buyer.address,
    lock: resaleLock, lockVault: resaleVault, onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: otherOnce, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
    paymentSource: otherUsdc, paymentDestination: h.buyerUsdc, price: 5n, ...ev }), other);
  h.slot(h.callState(call).gateUntil);
  await h.send('buy (v5)', h.buyIx(call), h.buyer);
  const callListing = (await findListingPda(call.call))[0];
  await h.send('list (v5)', once.getListInstruction({ holder: h.buyer, call: call.call, listing: callListing, price: 7n, ...ev }), h.buyer);
  await h.send('buy_put (v5)', once.getBuyPutInstruction({ buyer: h.buyer, config: h.config, put: heldPut.put, vault: heldPut.vault, usdcMint: h.usdc,
    usdcTokenProgram: TOKEN, paymentSource: h.buyerUsdc, paymentDestination: h.writerUsdc, ...ev }), h.buyer);
  const putListing = (await findListingPda(heldPut.put))[0];
  const listPut = once.getListPutInstruction({ holder: h.buyer, put: heldPut.put, listing: putListing, price: 9n, ...ev });
  await h.send('list_put unavailable in v5', listPut, h.buyer, '');
  const closeOut = once.getCloseOutInstruction({ writer: h.writer, call: call.call, vault: call.vault, mint: call.mint, tokenProgram: call.tokenProgram, destination: call.source, ...ev });
  // replace the executable at the same address and keep the upgrade authority
  const pd = h.svm.getAccount(h.programData) as any, authority = Buffer.from(pd.data).subarray(12, 45);
  h.svm.addProgramWithLoader(P, readFileSync(new URL('../target/deploy/once.so', import.meta.url)), LOADER);
  const pd2 = h.svm.getAccount(h.programData) as any, d2 = Buffer.from(pd2.data); d2.set(authority, 12); h.svm.setAccount({ ...pd2, data: d2 });
  expect(h.configState().nextId).toBe(6n);
  // the writer buys back the v5 call listing and takes the stock out
  const s0 = amount(h.svm, call.source);
  await h.send('buy back the v5 listing (buy_listed + close_out)', [once.getBuyListedInstruction({ buyer: h.writer, config: h.config, call: call.call, listing: callListing,
    seller: h.buyer.address, usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: h.writerUsdc, paymentDestination: h.buyerUsdc, price: 7n, ...ev }), closeOut], h.writer);
  expect(amount(h.svm, call.source) - s0).toBe(LOT);
  expect(h.callState(call).state).toBe(once.CallState.Cancelled);
  expect(unwrapOption(h.callState(call).holder)).toBe(h.writer.address);
  // the v5 held put sells, and its new holder can leave the same way
  await h.send('list_put on a v5 put', listPut, h.buyer);
  const next = await generateKeyPairSigner();
  h.svm.airdrop(next.address, 10_000_000_000n as any);
  const nextUsdc = await h.fundToken(next, h.usdc, TOKEN, 10_000_000n);
  await h.send('buy_listed_put on a v5 put', once.getBuyListedPutInstruction({ buyer: next, config: h.config, put: heldPut.put, listing: putListing, seller: h.buyer.address,
    usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: nextUsdc, paymentDestination: h.buyerUsdc, price: 9n, ...ev }), next);
  expect(unwrapOption(once.getPutDecoder().decode(Buffer.from((h.svm.getAccount(heldPut.put) as any).data)).holder)).toBe(next.address as Address);
  // v5 locks, open positions and the existing instructions as before
  h.slot(once.getPutDecoder().decode(Buffer.from((h.svm.getAccount(gatedPut.put) as any).data)).gateUntil);
  await h.send('return_lock on a v5 put lock', once.getReturnLockInstruction({ locker: h.buyer, config: h.config, lock: putLock, lockVault: putLockVault,
    onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: h.buyerOnce, ...ev }), h.buyer);
  await h.send('cancel_put on a v5 open put', once.getCancelPutInstruction({ writer: h.writer, put: openPut.put, vault: openPut.vault, usdcMint: h.usdc,
    usdcTokenProgram: TOKEN, destination: h.writerUsdc, ...ev }), h.writer);
  await h.send('cancel on a v5 open call', h.cancelIx(openCall), h.writer);
  const o0 = amount(h.svm, otherOnce);
  await h.send('return_resale_lock on a v5 ResaleLock', once.getReturnResaleLockInstruction({ locker: other, config: h.config, lock: resaleLock, lockVault: resaleVault,
    onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: otherOnce, ...ev }), other);
  expect(amount(h.svm, otherOnce) - o0).toBe(h.configState().lockAmount);
  await h.send('return_lock on a v5 call Lock', h.returnIx(resold), h.buyer);
  const c6 = await h.write();
  expect(c6.id).toBe(6n);
});
