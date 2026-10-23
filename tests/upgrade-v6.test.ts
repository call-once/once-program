/* Accounts made by the deployed executable keep working after the order binary replaces it, and an option made by an order takes the next id when it fills. */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getAddressEncoder, getProgramDerivedAddress, generateKeyPairSigner, unwrapOption, type ReadonlyUint8Array } from '@solana/kit';
import * as once from '../client/src/generated/index.js';
import { Harness, amount, LOT, STRIKE, PREMIUM } from './harness.js';
import { LOADER, TOKEN, TOKEN_2022, XSTOCKS } from '../client/constants.js';
import { findLockPda, findLockVaultPda, findListingPda, findOrderPda, findOrderVaultPda, findOrderOncePda } from '../client/pdas.js';

const V6 = process.env.ONCE_PREV_SO!, P = once.ONCE_PROGRAM_ADDRESS, enc = getAddressEncoder();
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const pda = async (...s: (string | ReadonlyUint8Array)[]) => (await getProgramDerivedAddress({ programAddress: P, seeds: s }))[0];

test.skipIf(!V6)('Config, calls, puts, locks, resale locks and listings from the deployed binary keep working after the order binary replaces it; an order takes no id and its option takes the next one', async () => {
  expect(execFileSync('solana-verify', ['get-executable-hash', V6], { encoding: 'utf8' }).trim()).toBe('22969a6a8eb83fe4384fad5110fbf8dcf86cdc7f41de0c70522bd7852a7445a2');
  const h = await Harness.create({ gated: true, binary: pathToFileURL(V6) });
  const ev = h.eventAccounts();
  const listed = await h.write(), openCall = await h.write(), gated = await h.write();
  const putAt = async (id: bigint) => { const put = await pda('put', u64(id)); return { put, vault: await pda('put_vault', enc.encode(put)) }; };
  const openPut = await putAt(3n);
  await h.send('write_put (v6)', once.getWritePutInstruction({ config: h.config, writer: h.writer, ...openPut, mint: XSTOCKS.NVDAx, tokenProgram: listed.tokenProgram,
    usdcMint: h.usdc, usdcTokenProgram: TOKEN, source: h.writerUsdc, id: 3n, lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: 2000n, ...ev }), h.writer);
  // a call bought inside its gate, offered inside it and bought from its holder inside it: a v6 Lock and a v6 ResaleLock
  await h.send('lock_and_buy (v6)', h.lockBuyIx(gated), h.buyer);
  const gListing = (await findListingPda(gated.call))[0];
  await h.send('list inside the gate (v6)', once.getListInstruction({ holder: h.buyer, call: gated.call, listing: gListing, price: 5n, ...ev }), h.buyer);
  const other = await generateKeyPairSigner();
  h.svm.airdrop(other.address, 10_000_000_000n as any);
  const otherUsdc = await h.fundToken(other, h.usdc, TOKEN, 10_000_000n), otherOnce = await h.fundToken(other, h.onceMint, h.onceProgram, 10_000_000n);
  const resaleLock = await pda('resale_lock', enc.encode(gated.call), enc.encode(other.address)), resaleVault = await pda('resale_lock_vault', enc.encode(gated.call), enc.encode(other.address));
  await h.send('lock_and_buy_listed (v6)', once.getLockAndBuyListedInstruction({ buyer: other, config: h.config, call: gated.call, listing: gListing, seller: h.buyer.address,
    lock: resaleLock, lockVault: resaleVault, onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: otherOnce, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
    paymentSource: otherUsdc, paymentDestination: h.buyerUsdc, price: 5n, ...ev }), other);
  h.slot(h.callState(listed).gateUntil);
  await h.send('buy (v6)', h.buyIx(listed), h.buyer);
  const listing = (await findListingPda(listed.call))[0];
  await h.send('list (v6)', once.getListInstruction({ holder: h.buyer, call: listed.call, listing, price: 7n, ...ev }), h.buyer);
  // an order cannot be placed under the deployed binary
  const nonce = 1n, order = (await findOrderPda(h.buyer.address, nonce))[0], orderVault = (await findOrderVaultPda(order))[0], orderOnce = (await findOrderOncePda(order))[0];
  const place = once.getPlaceOrderInstruction({ buyer: h.buyer, config: h.config, order, orderVault, orderOnce, mint: XSTOCKS.NVDAx, tokenProgram: TOKEN_2022,
    onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: h.buyerOnce, usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: h.buyerUsdc,
    nonce, kind: once.OptionKind.Call, lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: 2000n, ...ev });
  await h.send('place_order unavailable in v6', place, h.buyer, '');
  // replace the executable at the same address and keep the upgrade authority
  const pd = h.svm.getAccount(h.programData) as any, authority = Buffer.from(pd.data).subarray(12, 45);
  h.svm.addProgramWithLoader(P, readFileSync(new URL('../target/deploy/once.so', import.meta.url)), LOADER);
  const pd2 = h.svm.getAccount(h.programData) as any, d2 = Buffer.from(pd2.data); d2.set(authority, 12); h.svm.setAccount({ ...pd2, data: d2 });
  expect(h.configState().nextId).toBe(4n);
  // an order placed after the upgrade takes no id; a write takes 4 and the fill makes call 5
  await h.send('place_order after the upgrade', place, h.buyer);
  expect(h.configState().nextId).toBe(4n);
  expect((await h.write()).id).toBe(4n);
  const call5 = await pda('call', u64(5n)), stock = await h.fundToken(h.writer, XSTOCKS.NVDAx, TOKEN_2022, LOT * 10n);
  await h.send('fill_order after the upgrade', once.getFillOrderInstruction({ writer: h.writer, config: h.config, order, buyer: h.buyer.address, orderVault, orderOnce,
    call: call5, vault: await pda('vault', enc.encode(call5)), optionLock: (await findLockPda(call5))[0], optionLockVault: (await findLockVaultPda(call5))[0],
    mint: XSTOCKS.NVDAx, tokenProgram: TOKEN_2022, source: stock, usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentDestination: h.writerUsdc,
    onceMint: h.onceMint, onceTokenProgram: h.onceProgram, id: 5n, lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: 2000n, ...ev }), h.writer);
  const c5 = once.getCallAccountDecoder().decode(Buffer.from((h.svm.getAccount(call5) as any).data));
  expect(unwrapOption(c5.holder)).toBe(h.buyer.address);
  expect((await h.write()).id).toBe(6n);
  // the deployed binary's accounts as before: a v6 listing sells, the v6 Lock and ResaleLock return, open positions cancel
  await h.send('buy_listed on a v6 listing', once.getBuyListedInstruction({ buyer: other, config: h.config, call: listed.call, listing, seller: h.buyer.address,
    usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: otherUsdc, paymentDestination: h.buyerUsdc, price: 7n, ...ev }), other);
  const n0 = amount(h.svm, h.buyerOnce);
  await h.send('return_lock on a v6 Lock', h.returnIx(gated), h.buyer);
  expect(amount(h.svm, h.buyerOnce) - n0).toBe(h.configState().lockAmount);
  const o0 = amount(h.svm, otherOnce);
  await h.send('return_resale_lock on a v6 ResaleLock', once.getReturnResaleLockInstruction({ locker: other, config: h.config, lock: resaleLock, lockVault: resaleVault,
    onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: otherOnce, ...ev }), other);
  expect(amount(h.svm, otherOnce) - o0).toBe(h.configState().lockAmount);
  await h.send('cancel on a v6 open call', h.cancelIx(openCall), h.writer);
  await h.send('cancel_put on a v6 open put', once.getCancelPutInstruction({ writer: h.writer, put: openPut.put, vault: openPut.vault, usdcMint: h.usdc,
    usdcTokenProgram: TOKEN, destination: h.writerUsdc, ...ev }), h.writer);
  // the order's ONCE returns from the Lock of call 5 after its gate
  h.slot(c5.gateUntil);
  const n1 = amount(h.svm, h.buyerOnce);
  await h.send('return_lock on an order-made call', once.getReturnLockInstruction({ locker: h.buyer, config: h.config, lock: (await findLockPda(call5))[0],
    lockVault: (await findLockVaultPda(call5))[0], onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: h.buyerOnce, ...ev }), h.buyer);
  expect(amount(h.svm, h.buyerOnce) - n1).toBe(h.configState().lockAmount);
});
