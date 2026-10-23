/* Leaving before expiry: a held put sells at the holder's price; the writer buys back a call or put it wrote and takes its vault out in the same transaction. */
import { afterAll, describe, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { address, getAddressEncoder, getProgramDerivedAddress, generateKeyPairSigner, lamports, unwrapOption, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import * as once from '../client/src/generated/index.js';
import { Harness, amount, ata, LOT, STRIKE, PREMIUM, type Wallet, type CallRef } from './harness.js';
import { TOKEN, XSTOCKS } from '../client/constants.js';
import { findLockPda, findLockVaultPda, findListingPda, findResaleLockPda, findResaleLockVaultPda } from '../client/pdas.js';
import { writerStockDestination, type ExerciseRpc } from '../client/exercise.js';

const PROGRAM = once.ONCE_PROGRAM_ADDRESS, enc = getAddressEncoder();
const rows: Record<string, unknown>[] = [];
afterAll(() => { writeFileSync(new URL('../target/exit-measure.json', import.meta.url), JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? v.toString() : v, 1)); });
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

type PutRef = { id: bigint; put: Address; vault: Address; lock: Address; lockVault: Address; mint: Address; tokenProgram: Address; expiry: bigint };
type Party = { w: Wallet; usdc: Address; once: Address };

async function putRef(h: Harness, mint: Address = XSTOCKS.NVDAx, expiry = 2000n, id = h.configState().nextId): Promise<PutRef> {
  const put = (await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ['put', u64(id)] }))[0];
  const vault = (await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ['put_vault', enc.encode(put)] }))[0];
  const m = h.svm.getAccount(mint);
  if (!m.exists) throw new Error('Missing mint');
  return { id, put, vault, lock: (await findLockPda(put))[0], lockVault: (await findLockVaultPda(put))[0], mint, tokenProgram: m.programAddress, expiry };
}
const ev = (h: Harness) => h.eventAccounts();
const writePutIx = (h: Harness, p: PutRef) => once.getWritePutInstruction({ config: h.config, writer: h.writer, put: p.put, vault: p.vault, mint: p.mint,
  tokenProgram: p.tokenProgram, usdcMint: h.usdc, usdcTokenProgram: TOKEN, source: h.writerUsdc, id: p.id, lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: p.expiry, ...ev(h) });
const buyPutIx = (h: Harness, p: PutRef) => once.getBuyPutInstruction({ buyer: h.buyer, config: h.config, put: p.put, vault: p.vault, usdcMint: h.usdc,
  usdcTokenProgram: TOKEN, paymentSource: h.buyerUsdc, paymentDestination: h.writerUsdc, ...ev(h) });
const lockBuyPutIx = (h: Harness, p: PutRef) => once.getLockAndBuyPutInstruction({ config: h.config, put: p.put, buyer: h.buyer, lock: p.lock, lockVault: p.lockVault,
  onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: h.buyerOnce, vault: p.vault, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
  paymentSource: h.buyerUsdc, paymentDestination: h.writerUsdc, ...ev(h) });
const putState = (h: Harness, p: PutRef) => once.getPutDecoder().decode(Buffer.from((h.svm.getAccount(p.put) as any).data));
const gateEnd = (h: Harness, c: CallRef) => { const s = h.callState(c); return s.gateUntil === s.writtenSlot ? h.configState().gateFloor : s.gateUntil; };

async function party(h: Harness, usdc = 100_000_000n, onceAmount = 10_000_000n): Promise<Party> {
  const w = await generateKeyPairSigner();
  h.svm.airdrop(w.address, lamports(10_000_000_000n));
  return { w, usdc: await h.fundToken(w, h.usdc, TOKEN, usdc), once: await h.fundToken(w, h.onceMint, h.onceProgram, onceAmount) };
}
const buyerParty = (h: Harness): Party => ({ w: h.buyer, usdc: h.buyerUsdc, once: h.buyerOnce });
async function writerParty(h: Harness): Promise<Party> {
  return { w: h.writer, usdc: h.writerUsdc, once: await h.fundToken(h.writer, h.onceMint, h.onceProgram, 10_000_000n) };
}

/* the site sends two ComputeBudget instructions in front of every transaction */
const CB: Instruction[] = [
  { programAddress: address('ComputeBudget111111111111111111111111111111'), data: new Uint8Array([2, 192, 92, 21, 0]) },
  { programAddress: address('ComputeBudget111111111111111111111111111111'), data: new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0]) },
];
async function run(h: Harness, label: string, ixs: Instruction[], payer: TransactionSigner, failure?: string) {
  const all = [...CB, ...ixs];
  const tx = await h.transaction(all, payer);
  const bytes = 1 + 64 * Object.keys(tx.signatures).length + tx.messageBytes.length;
  expect(bytes, `${label}: signed transaction`).toBeLessThanOrEqual(1232);
  const result = await h.send(label, all, payer, failure);
  rows.push({ label, bytes, cu: (result as any).computeUnitsConsumed?.() ?? null, error: failure ?? null });
  return result;
}

/* call resale (existing) */
const listIx = async (h: Harness, c: CallRef, holder: Wallet, price: bigint) =>
  once.getListInstruction({ holder, call: c.call, listing: (await findListingPda(c.call))[0], price, ...ev(h) });
const buyListedIx = async (h: Harness, c: CallRef, buyer: Party, seller: Party, price: bigint) => once.getBuyListedInstruction({ buyer: buyer.w, config: h.config,
  call: c.call, listing: (await findListingPda(c.call))[0], seller: seller.w.address, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
  paymentSource: buyer.usdc, paymentDestination: seller.usdc, price, ...ev(h) });
const lockBuyListedIx = async (h: Harness, c: CallRef, buyer: Party, seller: Party, price: bigint) => once.getLockAndBuyListedInstruction({ buyer: buyer.w,
  config: h.config, call: c.call, listing: (await findListingPda(c.call))[0], seller: seller.w.address,
  lock: (await findResaleLockPda(c.call, buyer.w.address))[0], lockVault: (await findResaleLockVaultPda(c.call, buyer.w.address))[0],
  onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: buyer.once, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
  paymentSource: buyer.usdc, paymentDestination: seller.usdc, price, ...ev(h) });
/* put resale (new) */
const listPutIx = async (h: Harness, p: PutRef, holder: Wallet, price: bigint) =>
  once.getListPutInstruction({ holder, put: p.put, listing: (await findListingPda(p.put))[0], price, ...ev(h) });
const buyListedPutIx = async (h: Harness, p: PutRef, buyer: Party, seller: Party, price: bigint) => once.getBuyListedPutInstruction({ buyer: buyer.w,
  config: h.config, put: p.put, listing: (await findListingPda(p.put))[0], seller: seller.w.address, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
  paymentSource: buyer.usdc, paymentDestination: seller.usdc, price, ...ev(h) });
const lockBuyListedPutIx = async (h: Harness, p: PutRef, buyer: Party, seller: Party, price: bigint) => once.getLockAndBuyListedPutInstruction({ buyer: buyer.w,
  config: h.config, put: p.put, listing: (await findListingPda(p.put))[0], seller: seller.w.address,
  lock: (await findResaleLockPda(p.put, buyer.w.address))[0], lockVault: (await findResaleLockVaultPda(p.put, buyer.w.address))[0],
  onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: buyer.once, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
  paymentSource: buyer.usdc, paymentDestination: seller.usdc, price, ...ev(h) });
/* close out (new) */
const closeOutIx = (h: Harness, c: CallRef, destination: Address = c.source, writer: Wallet = h.writer) => once.getCloseOutInstruction({ writer,
  call: c.call, vault: c.vault, mint: c.mint, tokenProgram: c.tokenProgram, destination, ...ev(h) });
const closeOutPutIx = (h: Harness, p: PutRef, destination: Address = h.writerUsdc, writer: Wallet = h.writer) => once.getCloseOutPutInstruction({ writer,
  put: p.put, vault: p.vault, usdcMint: h.usdc, usdcTokenProgram: TOKEN, destination, ...ev(h) });
const unlistIx = async (h: Harness, seller: Wallet, at: Address) => once.getUnlistInstruction({ seller, listing: (await findListingPda(at))[0], ...ev(h) });
const returnResaleIx = async (h: Harness, at: Address, locker: Party) => once.getReturnResaleLockInstruction({ locker: locker.w, config: h.config,
  lock: (await findResaleLockPda(at, locker.w.address))[0], lockVault: (await findResaleLockVaultPda(at, locker.w.address))[0],
  onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: locker.once, ...ev(h) });
const returnLockIx = (h: Harness, lock: Address, lockVault: Address) => once.getReturnLockInstruction({ locker: h.buyer, config: h.config, lock, lockVault,
  onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: h.buyerOnce, ...ev(h) });

const svmRpc = (h: Harness): ExerciseRpc => ({
  async getAccount(a) { const acc = h.svm.getAccount(a); return acc.exists ? { programAddress: acc.programAddress, data: Uint8Array.from(acc.data) } : null; },
  async minimumBalance(n) { return h.svm.minimumBalanceForRentExemption(BigInt(n)); },
});
async function exercisePutIxs(h: Harness, p: PutRef, holder: Party) {
  const stockSource = await ata(holder.w.address, p.mint, p.tokenProgram);
  const d = await writerStockDestination({ writer: h.writer.address, mint: p.mint, tokenProgram: p.tokenProgram, payer: holder.w }, svmRpc(h));
  return [...d.instructions, once.getExercisePutInstruction({ holder: holder.w, put: p.put, vault: p.vault, mint: p.mint, tokenProgram: p.tokenProgram,
    stockSource, stockDestination: d.destination, usdcMint: h.usdc, usdcTokenProgram: TOKEN, destination: holder.usdc, writer: h.writer.address, ...ev(h) })];
}
async function writePut(h: Harness, expiry = 2000n) {
  const p = await putRef(h, XSTOCKS.NVDAx, expiry);
  await run(h, 'write_put', [writePutIx(h, p)], h.writer);
  return p;
}
const lamportsOf = (h: Harness, a: Address) => (h.svm.getAccount(a) as any).lamports as bigint;

describe('a held put sells at the holder\'s price', () => {
  test('after the gate: holder changes, the USDC stays in the vault, the seller is paid, the listing closes; the new holder puts once', async () => {
    const h = await Harness.create({ gated: true });
    const p = await writePut(h);
    h.slot(putState(h, p).gateUntil);
    await run(h, 'buy_put', [buyPutIx(h, p)], h.buyer);
    const seller = buyerParty(h), next = await party(h), price = 250_000n, listing = (await findListingPda(p.put))[0];
    await run(h, 'list_put:stranger', [await listPutIx(h, p, next.w, price)], next.w, 'NotHolder');
    await run(h, 'list_put:zero', [await listPutIx(h, p, seller.w, 0n)], seller.w, 'InvalidValue');
    await run(h, 'list:a put is not a call', [await listIx(h, { call: p.put } as CallRef, seller.w, price)], seller.w, 'AccountDiscriminatorMismatch');
    const sol0 = h.svm.getBalance(seller.w.address)!;
    await run(h, 'list_put', [await listPutIx(h, p, seller.w, price)], seller.w);
    const listingRent = lamportsOf(h, listing);
    rows.push({ label: 'put listing account', bytes: (h.svm.getAccount(listing) as any).data.length, rent: listingRent, sellerPaid: sol0 - h.svm.getBalance(seller.w.address)! });
    await run(h, 'buy_listed:a put listing is not a call listing', [await buyListedIx(h, { call: p.put } as CallRef, next, seller, price)], next.w, 'AccountDiscriminatorMismatch');
    await run(h, 'list_put:reprice', [await listPutIx(h, p, seller.w, price + 1n)], seller.w);
    await run(h, 'buy_listed_put:stale price', [await buyListedPutIx(h, p, next, seller, price)], next.w, 'PriceChanged');
    const bad = await buyListedPutIx(h, p, next, seller, price + 1n);
    const swap = (i: number, a: Address) => ({ ...bad, accounts: bad.accounts.map((x, j) => j === i ? { ...x, address: a } : x) });
    await run(h, 'buy_listed_put:payment to the writer', [swap(8, h.writerUsdc)], next.w, 'NotSeller');
    await run(h, 'buy_listed_put:rent to a stranger', [swap(4, h.stranger.address)], next.w, 'NotSeller');
    const vault0 = amount(h.svm, p.vault), w0 = amount(h.svm, h.writerUsdc), s0 = amount(h.svm, seller.usdc), n0 = amount(h.svm, next.usdc), sol1 = h.svm.getBalance(seller.w.address)!;
    await run(h, 'buy_listed_put', [await buyListedPutIx(h, p, next, seller, price + 1n)], next.w);
    expect(unwrapOption(putState(h, p).holder)).toBe(next.w.address);
    expect(putState(h, p).state).toBe(once.CallState.Held);
    expect(amount(h.svm, p.vault)).toBe(vault0);
    expect(amount(h.svm, h.writerUsdc)).toBe(w0);
    expect(amount(h.svm, seller.usdc) - s0).toBe(price + 1n);
    expect(n0 - amount(h.svm, next.usdc)).toBe(price + 1n);
    expect(h.svm.getAccount(listing).exists).toBe(false);
    expect(h.svm.getBalance(seller.w.address)! - sol1).toBe(listingRent);
    await h.fundToken(seller.w, p.mint, p.tokenProgram, LOT);
    await run(h, 'exercise_put:old holder', await exercisePutIxs(h, p, seller), seller.w, 'NotHolder');
    await h.fundToken(next.w, p.mint, p.tokenProgram, LOT);
    const n1 = amount(h.svm, next.usdc);
    await run(h, 'exercise_put:new holder', await exercisePutIxs(h, p, next), next.w);
    expect(amount(h.svm, next.usdc) - n1).toBe(STRIKE);
    expect(putState(h, p).state).toBe(once.CallState.Exercised);
  });

  test('a put listing left after the exercise cannot sell; the seller takes its rent back with the existing unlist', async () => {
    const h = await Harness.create({ gated: true });
    const p = await writePut(h);
    h.slot(putState(h, p).gateUntil);
    await run(h, 'buy_put', [buyPutIx(h, p)], h.buyer);
    const seller = buyerParty(h), next = await party(h);
    await run(h, 'list_put', [await listPutIx(h, p, seller.w, 300_000n)], seller.w);
    await h.fundToken(seller.w, p.mint, p.tokenProgram, LOT);
    await run(h, 'exercise_put', await exercisePutIxs(h, p, seller), seller.w);
    await run(h, 'buy_listed_put:after exercise', [await buyListedPutIx(h, p, next, seller, 300_000n)], next.w, '');
    await run(h, 'unlist:stranger', [await unlistIx(h, next.w, p.put)], next.w, 'NotSeller');
    await run(h, 'unlist (existing) on a put listing', [await unlistIx(h, seller.w, p.put)], seller.w);
    const q = await writePut(h, 3000n);
    h.slot(putState(h, q).gateUntil);
    await run(h, 'buy_put', [buyPutIx(h, q)], h.buyer);
    await run(h, 'list_put', [await listPutIx(h, q, seller.w, 300_000n)], seller.w);
    h.time(3000n);
    await run(h, 'buy_listed_put:after expiry', [await buyListedPutIx(h, q, next, seller, 300_000n)], next.w, 'Expired');
    await run(h, 'list_put:after expiry', [await listPutIx(h, q, seller.w, 1n)], seller.w, 'Expired');
  });
});

describe('inside the gate a resale only goes to a wallet that locks ONCE', () => {
  test('put: buy_listed_put fails InGate; lock_and_buy_listed_put locks; same-wallet rebuy stacks; locks return whole after the gate', async () => {
    const h = await Harness.create({ gated: true });
    const p = await writePut(h);
    await run(h, 'lock_and_buy_put', [lockBuyPutIx(h, p)], h.buyer);
    const first = buyerParty(h), second = await party(h), third = await party(h), lockAmount = h.configState().lockAmount, end = putState(h, p).gateUntil;
    await run(h, 'list_put in gate', [await listPutIx(h, p, first.w, 200_000n)], first.w);
    await run(h, 'buy_listed_put:in gate', [await buyListedPutIx(h, p, second, first, 200_000n)], second.w, 'InGate');
    const o2 = amount(h.svm, second.once);
    await run(h, 'lock_and_buy_listed_put', [await lockBuyListedPutIx(h, p, second, first, 200_000n)], second.w);
    expect(unwrapOption(putState(h, p).holder)).toBe(second.w.address);
    expect(o2 - amount(h.svm, second.once)).toBe(lockAmount);
    const secondLock = (await findResaleLockPda(p.put, second.w.address))[0];
    expect(once.getResaleLockDecoder().decode((h.svm.getAccount(secondLock) as any).data)).toMatchObject({ locker: second.w.address, call: p.put, amount: lockAmount, releaseSlot: end });
    await run(h, 'list_put again in gate', [await listPutIx(h, p, second.w, 210_000n)], second.w);
    await run(h, 'lock_and_buy_listed_put:third', [await lockBuyListedPutIx(h, p, third, second, 210_000n)], third.w);
    await run(h, 'list_put third', [await listPutIx(h, p, third.w, 220_000n)], third.w);
    await run(h, 'lock_and_buy_listed_put:second again', [await lockBuyListedPutIx(h, p, second, third, 220_000n)], second.w);
    expect(once.getResaleLockDecoder().decode((h.svm.getAccount(secondLock) as any).data).amount).toBe(lockAmount * 2n);
    await run(h, 'return_resale_lock:put, early', [await returnResaleIx(h, p.put, second)], second.w, 'LockNotReleased');
    await run(h, 'list_put second', [await listPutIx(h, p, second.w, 230_000n)], second.w);
    h.slot(end);
    const late = await party(h);
    await run(h, 'lock_and_buy_listed_put:after gate', [await lockBuyListedPutIx(h, p, late, second, 230_000n)], late.w, 'GateClosed');
    const before = [first, second, third].map(x => amount(h.svm, x.once));
    await run(h, 'return_lock:put lock (existing)', [returnLockIx(h, p.lock, p.lockVault)], h.buyer);
    await run(h, 'return_resale_lock:put, second (existing)', [await returnResaleIx(h, p.put, second)], second.w);
    await run(h, 'return_resale_lock:put, third (existing)', [await returnResaleIx(h, p.put, third)], third.w);
    expect(amount(h.svm, first.once) - before[0]!).toBe(lockAmount);
    expect(amount(h.svm, second.once) - before[1]!).toBe(lockAmount * 2n);
    expect(amount(h.svm, third.once) - before[2]!).toBe(lockAmount);
    await run(h, 'buy_listed_put:after gate', [await buyListedPutIx(h, p, late, second, 230_000n)], late.w);
    expect(unwrapOption(putState(h, p).holder)).toBe(late.w.address);
  });

  test('a ONCE deposit followed by a USDC failure leaves no lock and no listing change', async () => {
    const h = await Harness.create({ gated: true });
    const p = await writePut(h);
    await run(h, 'lock_and_buy_put', [lockBuyPutIx(h, p)], h.buyer);
    const first = buyerParty(h), poor = await party(h, 1n);
    await run(h, 'list_put', [await listPutIx(h, p, first.w, 200_000n)], first.w);
    await run(h, 'lock_and_buy_listed_put:no USDC', [await lockBuyListedPutIx(h, p, poor, first, 200_000n)], poor.w, '');
    expect(h.svm.getAccount((await findResaleLockPda(p.put, poor.w.address))[0]).exists).toBe(false);
  });
});

describe('the writer buys back and takes the vault out in the same transaction', () => {
  test('call: buy_listed + close_out; stock to the writer, price to the holder, vault and listing closed, Cancelled with the writer as holder', async () => {
    const h = await Harness.create({ gated: true });
    const c = await h.write(), open = await h.write();
    h.slot(gateEnd(h, c));
    await h.send('buy', h.buyIx(c), h.buyer);
    const seller = buyerParty(h), writer = await writerParty(h), price = 300_000n, listing = (await findListingPda(c.call))[0];
    await run(h, 'close_out:open call', [closeOutIx(h, open)], h.writer, 'NotHeld');
    await run(h, 'close_out:held by another wallet', [closeOutIx(h, c)], h.writer, 'NotHolder');
    await run(h, 'close_out:stranger', [closeOutIx(h, c, c.source, h.stranger)], h.stranger, 'NotWriter');
    await run(h, 'list', [await listIx(h, c, seller.w, price)], seller.w);
    // a failing take-back undoes the purchase in the same transaction
    await run(h, 'buy back:stock to an account the writer does not own', [await buyListedIx(h, c, writer, seller, price),
      closeOutIx(h, c, await ata(h.buyer.address, c.mint, c.tokenProgram).then(async a => (await h.fundToken(h.buyer, c.mint, c.tokenProgram, 1n), a)))], h.writer, '');
    expect(unwrapOption(h.callState(c).holder)).toBe(seller.w.address);
    const stock0 = amount(h.svm, c.source), wu0 = amount(h.svm, h.writerUsdc), su0 = amount(h.svm, seller.usdc);
    const wsol0 = h.svm.getBalance(h.writer.address)!, ssol0 = h.svm.getBalance(seller.w.address)!, vaultRent = lamportsOf(h, c.vault), listingRent = lamportsOf(h, listing);
    await run(h, 'buy back (buy_listed + close_out)', [await buyListedIx(h, c, writer, seller, price), closeOutIx(h, c)], h.writer);
    expect(amount(h.svm, c.source) - stock0).toBe(LOT);
    expect(wu0 - amount(h.svm, h.writerUsdc)).toBe(price);
    expect(amount(h.svm, seller.usdc) - su0).toBe(price);
    expect(h.svm.getBalance(seller.w.address)! - ssol0).toBe(listingRent);
    expect(h.svm.getBalance(h.writer.address)! - wsol0).toBe(vaultRent - 5000n);
    const s = h.callState(c);
    expect(s.state).toBe(once.CallState.Cancelled);
    expect(unwrapOption(s.holder)).toBe(h.writer.address);
    expect(h.svm.getAccount(c.vault).exists).toBe(false);
    expect(h.svm.getAccount(listing).exists).toBe(false);
    await run(h, 'close_out:again', [closeOutIx(h, c)], h.writer, '');
    await run(h, 'list:after close_out', [await listIx(h, c, h.writer, 1n)], h.writer, 'NotHeld');
    await run(h, 'call:after close_out', [await h.callIx(c, { holder: h.writer, paymentSource: h.writerUsdc, destination: c.source })], h.writer, '');
    h.time(2000n);
    await run(h, 'reclaim:after close_out', [h.reclaimIx(c)], h.writer, '');
  });

  test('put: buy_listed_put + close_out_put; the writer nets strike − price in USDC', async () => {
    const h = await Harness.create({ gated: true });
    const p = await writePut(h), open = await writePut(h);
    h.slot(putState(h, p).gateUntil);
    await run(h, 'buy_put', [buyPutIx(h, p)], h.buyer);
    const seller = buyerParty(h), writer = await writerParty(h), price = 150_000n;
    await run(h, 'close_out_put:open put', [closeOutPutIx(h, open)], h.writer, 'NotHeld');
    await run(h, 'close_out_put:held by another wallet', [closeOutPutIx(h, p)], h.writer, 'NotHolder');
    await run(h, 'close_out_put:stranger', [closeOutPutIx(h, p, h.buyerUsdc, h.stranger)], h.stranger, 'NotWriter');
    await run(h, 'list_put', [await listPutIx(h, p, seller.w, price)], seller.w);
    const wu0 = amount(h.svm, h.writerUsdc), su0 = amount(h.svm, seller.usdc), wsol0 = h.svm.getBalance(h.writer.address)!, vaultRent = lamportsOf(h, p.vault);
    await run(h, 'buy back put (buy_listed_put + close_out_put)', [await buyListedPutIx(h, p, writer, seller, price), closeOutPutIx(h, p)], h.writer);
    expect(amount(h.svm, h.writerUsdc) - wu0).toBe(STRIKE - price);
    expect(amount(h.svm, seller.usdc) - su0).toBe(price);
    expect(h.svm.getBalance(h.writer.address)! - wsol0).toBe(vaultRent - 5000n);
    expect(putState(h, p).state).toBe(once.CallState.Cancelled);
    expect(h.svm.getAccount(p.vault).exists).toBe(false);
    await h.fundToken(h.writer, p.mint, p.tokenProgram, LOT);
    await run(h, 'exercise_put:after close_out', await exercisePutIxs(h, p, writer), h.writer, '');
    h.time(2000n);
    await run(h, 'reclaim_put:after close_out', [once.getReclaimPutInstruction({ writer: h.writer, put: p.put, vault: p.vault, usdcMint: h.usdc,
      usdcTokenProgram: TOKEN, destination: h.writerUsdc, ...ev(h) })], h.writer, '');
  });

  test('put: a writer holding less USDC than the price cannot buy back, though the vault holds the strike', async () => {
    const h = await Harness.create({ gated: true });
    const p = await writePut(h);
    h.slot(putState(h, p).gateUntil);
    await run(h, 'buy_put', [buyPutIx(h, p)], h.buyer);
    const seller = buyerParty(h), writer = await writerParty(h), all = amount(h.svm, h.writerUsdc);
    const sink = await party(h, 0n);
    await h.donate(h.writerUsdc, sink.usdc, h.usdc, TOKEN, h.writer, all - 1n);
    await run(h, 'list_put', [await listPutIx(h, p, seller.w, 2n)], seller.w);
    await run(h, 'buy back put:writer short of the price', [await buyListedPutIx(h, p, writer, seller, 2n), closeOutPutIx(h, p)], h.writer, '');
  });

  test('inside the gate the writer buys back only by locking ONCE, for a call and for a put; its lock returns after the gate', async () => {
    const h = await Harness.create({ gated: true });
    const c = await h.write(), p = await writePut(h);
    await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
    await run(h, 'lock_and_buy_put', [lockBuyPutIx(h, p)], h.buyer);
    const seller = buyerParty(h), writer = await writerParty(h), lockAmount = h.configState().lockAmount;
    await run(h, 'list', [await listIx(h, c, seller.w, 100_000n)], seller.w);
    await run(h, 'list_put', [await listPutIx(h, p, seller.w, 100_000n)], seller.w);
    await run(h, 'buy back in gate, no lock', [await buyListedIx(h, c, writer, seller, 100_000n), closeOutIx(h, c)], h.writer, 'InGate');
    await run(h, 'buy back put in gate, no lock', [await buyListedPutIx(h, p, writer, seller, 100_000n), closeOutPutIx(h, p)], h.writer, 'InGate');
    const o0 = amount(h.svm, writer.once);
    await run(h, 'buy back in gate (lock_and_buy_listed + close_out)', [await lockBuyListedIx(h, c, writer, seller, 100_000n), closeOutIx(h, c)], h.writer);
    await run(h, 'buy back put in gate (lock_and_buy_listed_put + close_out_put)', [await lockBuyListedPutIx(h, p, writer, seller, 100_000n), closeOutPutIx(h, p)], h.writer);
    expect(o0 - amount(h.svm, writer.once)).toBe(lockAmount * 2n);
    expect(h.callState(c).state).toBe(once.CallState.Cancelled);
    expect(putState(h, p).state).toBe(once.CallState.Cancelled);
    await run(h, 'return_resale_lock:writer, early', [await returnResaleIx(h, c.call, writer)], h.writer, 'LockNotReleased');
    h.slot(gateEnd(h, c) > putState(h, p).gateUntil ? gateEnd(h, c) : putState(h, p).gateUntil);
    await run(h, 'return_resale_lock:writer, call', [await returnResaleIx(h, c.call, writer)], h.writer);
    await run(h, 'return_resale_lock:writer, put', [await returnResaleIx(h, p.put, writer)], h.writer);
    expect(amount(h.svm, writer.once)).toBe(o0);
    await run(h, 'return_lock:first buyer, call', [h.returnIx(c)], h.buyer);
    await run(h, 'return_lock:first buyer, put', [returnLockIx(h, p.lock, p.lockVault)], h.buyer);
  });

  test('transaction size with the writer\'s stock account created in the same transaction', async () => {
    const h = await Harness.create({ gated: true });
    const c = await h.write();
    await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
    const seller = buyerParty(h), writer = await writerParty(h);
    await run(h, 'list', [await listIx(h, c, seller.w, 100_000n)], seller.w);
    // the writer's stock account is closed: the site creates the canonical account in the same transaction
    const stock = amount(h.svm, c.source), sink = await party(h, 0n);
    const sinkStock = await h.fundToken(sink.w, c.mint, c.tokenProgram, 0n);
    await h.donate(c.source, sinkStock, c.mint, c.tokenProgram, h.writer, stock);
    await h.send('close writer stock account', (await import('@solana-program/token-2022')).getCloseAccountInstruction({ account: c.source, destination: h.writer.address, owner: h.writer }, { programAddress: c.tokenProgram }), h.writer);
    const create = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: h.writer, owner: h.writer.address, mint: c.mint, tokenProgram: c.tokenProgram });
    await run(h, 'buy back in gate + create stock account (largest)', [create, await lockBuyListedIx(h, c, writer, seller, 100_000n), closeOutIx(h, c)], h.writer);
    expect(amount(h.svm, c.source)).toBe(LOT);
  });
});
