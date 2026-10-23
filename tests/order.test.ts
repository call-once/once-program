/* Ordering an option: a wallet that locks ONCE names the terms and puts the premium up; a writer who takes the order fills the vault and the option is the buyer's in the same transaction. */
import { afterAll, describe, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { address, getAddressEncoder, getProgramDerivedAddress, generateKeyPairSigner, lamports, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import * as once from '../client/src/generated/index.js';
import { Harness, amount, ata, LOT, STRIKE, PREMIUM, type Wallet, type CallRef } from './harness.js';
import { TOKEN, TOKEN_2022, XSTOCKS } from '../client/constants.js';
import { findLockPda, findLockVaultPda, findListingPda, findResaleLockPda, findResaleLockVaultPda, findOrderPda, findOrderVaultPda, findOrderOncePda } from '../client/pdas.js';
import { writerStockDestination, type ExerciseRpc } from '../client/exercise.js';

const PROGRAM = once.ONCE_PROGRAM_ADDRESS, enc = getAddressEncoder();
const rows: Record<string, unknown>[] = [];
afterAll(() => { writeFileSync(new URL('../target/order-measure.json', import.meta.url), JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? v.toString() : v, 1)); });
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

type Kind = 'call' | 'put';
type Terms = { lot: bigint; strike: bigint; premium: bigint; expiryTs: bigint };
type OrderRef = { nonce: bigint; kind: Kind; buyer: Address; order: Address; vault: Address; once: Address; mint: Address; tokenProgram: Address; terms: Terms };
type OptionRef = { id: bigint; option: Address; optionVault: Address; lock: Address; lockVault: Address };
type Party = { w: Wallet; usdc: Address; once: Address };

let nonces = 0n;
async function orderRef(h: Harness, kind: Kind, buyer: Address, over: Partial<Terms> & { mint?: Address; nonce?: bigint } = {}): Promise<OrderRef> {
  const nonce = over.nonce ?? ++nonces, mint = over.mint ?? XSTOCKS.NVDAx;
  const order = (await findOrderPda(buyer, nonce))[0];
  const m = h.svm.getAccount(mint);
  if (!m.exists) throw new Error('Missing mint');
  return { nonce, kind, buyer, order, vault: (await findOrderVaultPda(order))[0], once: (await findOrderOncePda(order))[0], mint, tokenProgram: m.programAddress,
    terms: { lot: over.lot ?? LOT, strike: over.strike ?? STRIKE, premium: over.premium ?? PREMIUM, expiryTs: over.expiryTs ?? 2000n } };
}
/* the option a fill makes takes the id next in line when it fills */
async function optionRef(h: Harness, kind: Kind, id = h.configState().nextId): Promise<OptionRef> {
  const option = (await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [kind, u64(id)] }))[0];
  return { id, option, optionVault: (await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [kind === 'call' ? 'vault' : 'put_vault', enc.encode(option)] }))[0],
    lock: (await findLockPda(option))[0], lockVault: (await findLockVaultPda(option))[0] };
}
const ev = (h: Harness) => h.eventAccounts();
const placeIx = (h: Harness, o: OrderRef, buyer: Party, over: Partial<Terms & { kind: once.OptionKind }> = {}) => once.getPlaceOrderInstruction({ buyer: buyer.w,
  config: h.config, order: o.order, orderVault: o.vault, orderOnce: o.once, mint: o.mint, tokenProgram: o.tokenProgram, onceMint: h.onceMint,
  onceTokenProgram: h.onceProgram, onceSource: buyer.once, usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: buyer.usdc, nonce: o.nonce,
  kind: o.kind === 'call' ? once.OptionKind.Call : once.OptionKind.Put, ...o.terms, ...over, ...ev(h) });
const cancelIx = (h: Harness, o: OrderRef, buyer: Party, signer: Wallet = buyer.w) => once.getCancelOrderInstruction({ buyer: signer, config: h.config,
  order: o.order, orderVault: o.vault, orderOnce: o.once, onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceDestination: buyer.once,
  usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentDestination: buyer.usdc, ...ev(h) });
type FillOver = { buyer?: Address; terms?: Partial<Terms> };
const fillIx = (h: Harness, o: OrderRef, x: OptionRef, writer: Party, stock: Address, over: FillOver = {}) => once.getFillOrderInstruction({ writer: writer.w,
  config: h.config, order: o.order, buyer: over.buyer ?? o.buyer, orderVault: o.vault, orderOnce: o.once, call: x.option, vault: x.optionVault,
  optionLock: x.lock, optionLockVault: x.lockVault, mint: o.mint, tokenProgram: o.tokenProgram, source: stock, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
  paymentDestination: writer.usdc, onceMint: h.onceMint, onceTokenProgram: h.onceProgram, id: x.id, ...o.terms, ...over.terms, ...ev(h) });
const fillPutIx = (h: Harness, o: OrderRef, x: OptionRef, writer: Party, over: FillOver = {}) => once.getFillPutOrderInstruction({ writer: writer.w,
  config: h.config, order: o.order, buyer: over.buyer ?? o.buyer, orderVault: o.vault, orderOnce: o.once, put: x.option, vault: x.optionVault,
  optionLock: x.lock, optionLockVault: x.lockVault, mint: o.mint, usdcMint: h.usdc, usdcTokenProgram: TOKEN, usdc: writer.usdc, onceMint: h.onceMint,
  onceTokenProgram: h.onceProgram, id: x.id, ...o.terms, ...over.terms, ...ev(h) });
const returnLockIx = (h: Harness, x: OptionRef, locker: Party) => once.getReturnLockInstruction({ locker: locker.w, config: h.config, lock: x.lock,
  lockVault: x.lockVault, onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: locker.once, ...ev(h) });
const swap = (ix: Instruction, from: Address, to: Address): Instruction => ({ ...ix, accounts: ix.accounts!.map(a => a.address === from ? { ...a, address: to } : a) });
const callState = (h: Harness, x: OptionRef) => once.getCallAccountDecoder().decode(Buffer.from((h.svm.getAccount(x.option) as any).data));
const putState = (h: Harness, x: OptionRef) => once.getPutDecoder().decode(Buffer.from((h.svm.getAccount(x.option) as any).data));
const lockState = (h: Harness, x: OptionRef) => once.getLockDecoder().decode(Buffer.from((h.svm.getAccount(x.lock) as any).data));
const exists = (h: Harness, a: Address) => h.svm.getAccount(a).exists;
const sol = (h: Harness, a: Address) => h.svm.getBalance(a) ?? 0n;
const rent = (h: Harness, a: Address) => (h.svm.getAccount(a) as any).lamports as bigint;
const callRef = (o: OrderRef, x: OptionRef, source: Address): CallRef => ({ id: x.id, call: x.option, vault: x.optionVault, lock: x.lock, lockVault: x.lockVault,
  mint: o.mint, tokenProgram: o.tokenProgram, source, expiry: o.terms.expiryTs });

async function party(h: Harness, usdc = 100_000_000n, onceAmount = 10_000_000n): Promise<Party> {
  const w = await generateKeyPairSigner();
  h.svm.airdrop(w.address, lamports(10_000_000_000n));
  return { w, usdc: await h.fundToken(w, h.usdc, TOKEN, usdc), once: await h.fundToken(w, h.onceMint, h.onceProgram, onceAmount) };
}
const buyerParty = (h: Harness): Party => ({ w: h.buyer, usdc: h.buyerUsdc, once: h.buyerOnce });
async function writerParty(h: Harness): Promise<Party & { stock: Address }> {
  return { w: h.writer, usdc: h.writerUsdc, once: await h.fundToken(h.writer, h.onceMint, h.onceProgram, 10_000_000n),
    stock: await h.fundToken(h.writer, XSTOCKS.NVDAx, TOKEN_2022, LOT * 10n) };
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
  const why = failure === '' ? ((result as any).logs?.() as string[]).filter(l => /rror|failed|insufficient|in use/i.test(l)).slice(-2).join(' | ') : undefined;
  rows.push({ label, bytes, cu: (result as any).computeUnitsConsumed?.() ?? null, error: failure ?? null, why, once: h.onceProgram === TOKEN ? 'classic' : '2022' });
  return result;
}
const svmRpc = (h: Harness): ExerciseRpc => ({
  async getAccount(a) { const acc = h.svm.getAccount(a); return acc.exists ? { programAddress: acc.programAddress, data: Uint8Array.from(acc.data) } : null; },
  async minimumBalance(n) { return h.svm.minimumBalanceForRentExemption(BigInt(n)); },
});

describe('a call order', () => {
  test('placing locks the ONCE and puts the premium up and takes no id; a writer fills it with the next id, the call is the buyer\'s in that transaction, and the ONCE returns whole after the call\'s gate', async () => {
    const h = await Harness.create({ gated: true });
    const buyer = buyerParty(h), writer = await writerParty(h), lockAmount = h.configState().lockAmount;
    const o = await orderRef(h, 'call', buyer.w.address), id0 = h.configState().nextId;
    const u0 = amount(h.svm, buyer.usdc), n0 = amount(h.svm, buyer.once), s0 = sol(h, buyer.w.address);
    await run(h, 'place_order (call)', [placeIx(h, o, buyer)], buyer.w);
    expect(h.configState().nextId).toBe(id0);
    expect(u0 - amount(h.svm, buyer.usdc)).toBe(PREMIUM);
    expect(n0 - amount(h.svm, buyer.once)).toBe(lockAmount);
    const rents = { order: rent(h, o.order), vault: rent(h, o.vault), once: rent(h, o.once) };
    expect(s0 - sol(h, buyer.w.address)).toBe(rents.order + rents.vault + rents.once + h.lastFee);
    rows.push({ label: 'order accounts', order: { bytes: (h.svm.getAccount(o.order) as any).data.length, rent: rents.order }, orderVault: rents.vault, orderOnce: rents.once });
    // a write while the order stands takes the next id; the fill takes the one after it
    const written = await h.write();
    expect(written.id).toBe(id0);
    h.slot(1_500n);
    await run(h, 'fill_order naming a taken id', [fillIx(h, o, await optionRef(h, 'call', id0), writer, writer.stock)], writer.w, 'IdMismatch');
    const x = await optionRef(h, 'call');
    expect(x.id).toBe(id0 + 1n);
    const st0 = amount(h.svm, writer.stock), wu0 = amount(h.svm, writer.usdc), ws0 = sol(h, writer.w.address), bs0 = sol(h, buyer.w.address);
    await run(h, 'fill_order', [fillIx(h, o, x, writer, writer.stock)], writer.w);
    expect(h.configState().nextId).toBe(id0 + 2n);
    expect(st0 - amount(h.svm, writer.stock)).toBe(LOT);
    expect(amount(h.svm, writer.usdc) - wu0).toBe(PREMIUM);
    // the writer pays the rent of the call, its vault, the Lock and the Lock's ONCE account; the order's rent goes back to the buyer
    const lockRents = rent(h, x.lock) + rent(h, x.lockVault);
    expect(ws0 - sol(h, writer.w.address)).toBe(rent(h, x.option) + rent(h, x.optionVault) + lockRents + h.lastFee);
    rows.push({ label: 'fill rents', call: rent(h, x.option), vault: rent(h, x.optionVault), lock: rent(h, x.lock), lockVault: rent(h, x.lockVault) });
    expect(sol(h, buyer.w.address) - bs0).toBe(rents.order + rents.vault + rents.once);
    for (const a of [o.order, o.vault, o.once]) expect(exists(h, a)).toBe(false);
    expect(callState(h, x)).toMatchObject({ id: id0 + 1n, writer: writer.w.address, state: once.CallState.Held, holder: { __option: 'Some', value: buyer.w.address },
      mint: o.mint, tokenProgram: o.tokenProgram, lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: 2000n, writtenSlot: 1_500n, boughtSlot: 1_500n, gateUntil: 1_651n });
    expect(lockState(h, x)).toMatchObject({ locker: buyer.w.address, call: x.option, amount: lockAmount, releaseSlot: 1_651n });
    expect(amount(h.svm, x.lockVault)).toBe(lockAmount);
    // the option is held: nobody buys it
    const ref = callRef(o, x, writer.stock);
    await run(h, 'buy on an order-made call', [h.buyIx(ref, { buyer: h.stranger })], h.stranger, 'NotOpen');
    // the ONCE comes back whole from the end of the call's gate
    await run(h, 'return_lock inside the gate', [returnLockIx(h, x, buyer)], buyer.w, 'LockNotReleased');
    h.slot(1_651n);
    const n1 = amount(h.svm, buyer.once);
    await run(h, 'return_lock after the gate', [returnLockIx(h, x, buyer)], buyer.w);
    expect(amount(h.svm, buyer.once) - n1).toBe(lockAmount);
    expect(amount(h.svm, buyer.once)).toBe(n0);
    // the order's rent came back at the fill; the Lock's comes to the locker with the ONCE; three fees: place, the refused return, the return
    expect(sol(h, buyer.w.address) - s0).toBe(lockRents - 3n * 5_000n);
    // the buyer calls it like any call
    const hs0 = amount(h.svm, writer.usdc);
    await run(h, 'call on an order-made call', [await h.callIx(ref)], buyer.w);
    expect(amount(h.svm, writer.usdc) - hs0).toBe(STRIKE);
    expect(amount(h.svm, await ata(buyer.w.address, o.mint, o.tokenProgram))).toBe(LOT);
  });
});

describe('a put order', () => {
  test('the writer needs only the strike less the premium; one raw less and nothing moves; the put is the buyer\'s and puts once', async () => {
    const h = await Harness.create({ gated: true });
    const buyer = buyerParty(h);
    const o = await orderRef(h, 'put', buyer.w.address);
    await run(h, 'place_order (put)', [placeIx(h, o, buyer)], buyer.w);
    const x = await optionRef(h, 'put');
    const short = await party(h, STRIKE - PREMIUM - 1n, 0n);
    await run(h, 'fill_put_order: one raw short of the strike less the premium', [fillPutIx(h, o, x, short)], short.w, '');
    const writer = await party(h, STRIKE - PREMIUM, 0n);
    await run(h, 'fill_put_order', [fillPutIx(h, o, x, writer)], writer.w);
    expect(amount(h.svm, writer.usdc)).toBe(0n);
    expect(amount(h.svm, x.optionVault)).toBe(STRIKE);
    expect(putState(h, x)).toMatchObject({ id: x.id, writer: writer.w.address, state: once.CallState.Held, holder: { __option: 'Some', value: buyer.w.address }, premium: PREMIUM });
    expect(lockState(h, x)).toMatchObject({ locker: buyer.w.address, call: x.option, releaseSlot: putState(h, x).gateUntil });
    // the holder hands over the lot and takes the strike
    const stock = await h.fundToken(h.buyer, o.mint, o.tokenProgram, LOT);
    const d = await writerStockDestination({ writer: writer.w.address, mint: o.mint, tokenProgram: o.tokenProgram, payer: buyer.w }, svmRpc(h));
    const u0 = amount(h.svm, buyer.usdc);
    await run(h, 'exercise_put on an order-made put', [...d.instructions, once.getExercisePutInstruction({ holder: buyer.w, put: x.option, vault: x.optionVault,
      mint: o.mint, tokenProgram: o.tokenProgram, stockSource: stock, stockDestination: d.destination, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
      destination: buyer.usdc, writer: writer.w.address, ...ev(h) })], buyer.w);
    expect(amount(h.svm, buyer.usdc) - u0).toBe(STRIKE);
    expect(amount(h.svm, d.destination)).toBe(LOT);
  });
});

describe('cancelling an order', () => {
  test('the premium, the ONCE placed and every rent come back; no id was used; nothing fills it afterwards', async () => {
    const h = await Harness.create({ gated: true });
    const buyer = buyerParty(h), writer = await writerParty(h), lockAmount = h.configState().lockAmount;
    const o = await orderRef(h, 'call', buyer.w.address), id0 = h.configState().nextId;
    const u0 = amount(h.svm, buyer.usdc), n0 = amount(h.svm, buyer.once), s0 = sol(h, buyer.w.address);
    await run(h, 'place_order', [placeIx(h, o, buyer)], buyer.w);
    // a later change of the lock amount does not change what comes back
    await h.send('set_params', h.paramsIx(151n, lockAmount * 2n), h.admin);
    const stranger = await party(h);
    await run(h, 'cancel_order by another wallet', [cancelIx(h, o, buyer, stranger.w)], stranger.w, 'NotBuyer');
    await run(h, 'cancel_order to another wallet\'s ONCE account', [swap(cancelIx(h, o, buyer), buyer.once, stranger.once)], buyer.w, 'ConstraintTokenOwner');
    await run(h, 'cancel_order', [cancelIx(h, o, buyer)], buyer.w);
    expect(amount(h.svm, buyer.usdc)).toBe(u0);
    expect(amount(h.svm, buyer.once)).toBe(n0);
    // every rent is back; the buyer is out three fees: place, the refused cancel, cancel
    expect(s0 - sol(h, buyer.w.address)).toBe(3n * 5_000n);
    for (const a of [o.order, o.vault, o.once]) expect(exists(h, a)).toBe(false);
    await run(h, 'fill_order after cancel', [fillIx(h, o, await optionRef(h, 'call'), writer, writer.stock)], writer.w, '');
    await run(h, 'cancel_order twice', [cancelIx(h, o, buyer)], buyer.w, '');
    const next = await h.write();
    expect(next.id).toBe(id0);
  });
});

describe('placing an order', () => {
  test('needs ONCE set, positive terms, a future expiry, a mint the option takes, and the ONCE and the premium; it takes no id', async () => {
    const plain = await Harness.create({ gated: false });
    await run(plain, 'place_order before ONCE is set', [placeIx(plain, await orderRef(plain, 'call', plain.buyer.address), buyerParty(plain))], plain.buyer, 'OnceNotSet');
    const h = await Harness.create({ gated: true });
    const buyer = buyerParty(h), id0 = h.configState().nextId;
    const o = await orderRef(h, 'call', buyer.w.address);
    await run(h, 'place_order: lot 0', [placeIx(h, o, buyer, { lot: 0n })], buyer.w, 'InvalidValue');
    await run(h, 'place_order: strike 0', [placeIx(h, o, buyer, { strike: 0n })], buyer.w, 'InvalidValue');
    await run(h, 'place_order: premium 0', [placeIx(h, o, buyer, { premium: 0n })], buyer.w, 'InvalidValue');
    await run(h, 'place_order: expiry now', [placeIx(h, o, buyer, { expiryTs: 1_000n })], buyer.w, 'ExpiryNotFuture');
    const hook = await h.createMint(TOKEN_2022, 'hook');
    await run(h, 'place_order: a mint with a transfer hook', [placeIx(h, await orderRef(h, 'call', buyer.w.address, { mint: hook }), buyer)], buyer.w, 'TransferHookActive');
    const noOnce = await party(h, 100_000_000n, 0n), noUsdc = await party(h, PREMIUM - 1n);
    await run(h, 'place_order without the ONCE', [placeIx(h, await orderRef(h, 'call', noOnce.w.address), noOnce)], noOnce.w, '');
    await run(h, 'place_order without the premium', [placeIx(h, await orderRef(h, 'call', noUsdc.w.address), noUsdc)], noUsdc.w, '');
    await run(h, 'place_order paying from another wallet\'s USDC', [swap(placeIx(h, o, buyer), buyer.usdc, noUsdc.usdc)], buyer.w, 'ConstraintTokenOwner');
    await run(h, 'place_order', [placeIx(h, o, buyer)], buyer.w);
    await run(h, 'place_order at an address that stands', [placeIx(h, o, buyer)], buyer.w, '');
    await run(h, 'place_order (put, same wallet)', [placeIx(h, await orderRef(h, 'put', buyer.w.address), buyer)], buyer.w);
    // orders take no ids: the next write takes the id it would have taken
    expect(h.configState().nextId).toBe(id0);
    expect((await h.write()).id).toBe(id0);
  });
});

describe('filling an order', () => {
  test('takes the kind ordered, the next id, the terms the writer names, before expiry, the order\'s mint, with the rent to the order\'s buyer and the premium to the writer; a second fill fails', async () => {
    const h = await Harness.create({ gated: true });
    const buyer = buyerParty(h), writer = await writerParty(h);
    const co = await orderRef(h, 'call', buyer.w.address), po = await orderRef(h, 'put', buyer.w.address);
    await run(h, 'place_order (call)', [placeIx(h, co, buyer)], buyer.w);
    await run(h, 'place_order (put)', [placeIx(h, po, buyer)], buyer.w);
    const xc = await optionRef(h, 'call'), xp = await optionRef(h, 'put');
    await run(h, 'fill_put_order on a call order', [fillPutIx(h, co, xp, writer)], writer.w, 'WrongKind');
    await run(h, 'fill_order on a put order', [fillIx(h, po, xc, writer, writer.stock)], writer.w, 'WrongKind');
    await run(h, 'fill_order naming an id ahead', [fillIx(h, co, await optionRef(h, 'call', xc.id + 1n), writer, writer.stock)], writer.w, 'IdMismatch');
    for (const [name, terms] of [['lot', { lot: LOT - 1n }], ['strike', { strike: STRIKE + 1n }], ['premium', { premium: PREMIUM + 1n }], ['expiry', { expiryTs: 1_999n }]] as const)
      await run(h, `fill_order naming another ${name}`, [fillIx(h, co, xc, writer, writer.stock, { terms })], writer.w, 'TermsMismatch');
    await run(h, 'fill_put_order naming another premium', [fillPutIx(h, po, xp, writer, { terms: { premium: PREMIUM - 1n } })], writer.w, 'TermsMismatch');
    const tsla = await h.fundToken(h.writer, XSTOCKS.TSLAx, TOKEN_2022, LOT);
    await run(h, 'fill_order with another stock', [fillIx(h, { ...co, mint: XSTOCKS.TSLAx }, xc, writer, tsla)], writer.w, 'WrongMint');
    await run(h, 'fill_order with the rent to another wallet', [fillIx(h, co, xc, writer, writer.stock, { buyer: h.stranger.address })], writer.w, 'NotBuyer');
    const other = await party(h);
    await run(h, 'fill_order with the premium to another wallet', [fillIx(h, co, xc, { ...writer, usdc: other.usdc }, writer.stock)], writer.w, 'ConstraintTokenOwner');
    const strangerStock = await h.fundToken(h.stranger, XSTOCKS.NVDAx, TOKEN_2022, LOT);
    await run(h, 'fill_order from another wallet\'s stock', [fillIx(h, co, xc, writer, strangerStock)], writer.w, 'ConstraintTokenOwner');
    const shortWriter = await party(h);
    const shortStock = await h.fundToken(shortWriter.w, XSTOCKS.NVDAx, TOKEN_2022, LOT - 1n);
    await run(h, 'fill_order one raw short of the lot', [fillIx(h, co, xc, shortWriter, shortStock)], shortWriter.w, '');
    h.time(2_000n);
    await run(h, 'fill_order at expiry', [fillIx(h, co, xc, writer, writer.stock)], writer.w, 'ExpiryNotFuture');
    await run(h, 'fill_put_order at expiry', [fillPutIx(h, po, xp, writer)], writer.w, 'ExpiryNotFuture');
    // after expiry the buyer still takes everything back
    await run(h, 'cancel_order after expiry', [cancelIx(h, po, buyer)], buyer.w);
    h.time(1_000n);
    // withdrawn and placed again at the same address on other terms: a fill naming the terms it read fails
    await run(h, 'cancel_order', [cancelIx(h, co, buyer)], buyer.w);
    const again = await orderRef(h, 'call', buyer.w.address, { nonce: co.nonce, premium: PREMIUM / 2n });
    expect(again.order).toBe(co.order);
    await run(h, 'place_order again at the same address', [placeIx(h, again, buyer)], buyer.w);
    await run(h, 'fill_order naming the withdrawn terms', [fillIx(h, again, xc, writer, writer.stock, { terms: co.terms })], writer.w, 'TermsMismatch');
    await run(h, 'fill_order', [fillIx(h, again, xc, writer, writer.stock)], writer.w);
    expect(callState(h, xc).premium).toBe(PREMIUM / 2n);
    await run(h, 'fill_order again', [fillIx(h, again, await optionRef(h, 'call'), writer, writer.stock)], writer.w, '');
    await run(h, 'cancel_order after fill', [cancelIx(h, again, buyer)], buyer.w, '');
    // a buyer can fill its own order
    const own = await orderRef(h, 'call', buyer.w.address);
    await run(h, 'place_order (own)', [placeIx(h, own, buyer)], buyer.w);
    const ownStock = await h.fundToken(h.buyer, XSTOCKS.NVDAx, TOKEN_2022, LOT);
    const xo = await optionRef(h, 'call');
    await run(h, 'fill_order by its buyer', [fillIx(h, own, xo, buyer, ownStock)], buyer.w);
    expect(callState(h, xo)).toMatchObject({ writer: buyer.w.address, holder: { __option: 'Some', value: buyer.w.address } });
  });

  test('a donation to the order\'s accounts goes with them: USDC to the writer on fill and to the buyer on cancel, ONCE into the lock and back; lamports sent to the lock address block nothing', async () => {
    const h = await Harness.create({ gated: true });
    const buyer = buyerParty(h), writer = await writerParty(h), donor = await party(h), lockAmount = h.configState().lockAmount;
    const a = await orderRef(h, 'call', buyer.w.address);
    await run(h, 'place_order', [placeIx(h, a, buyer)], buyer.w);
    await h.donate(donor.usdc, a.vault, h.usdc, TOKEN, donor.w, 7n);
    await h.donate(donor.once, a.once, h.onceMint, h.onceProgram, donor.w, 3n);
    const x = await optionRef(h, 'call');
    h.svm.airdrop(x.lock, lamports(1_000_000n));
    const w0 = amount(h.svm, writer.usdc), ws0 = sol(h, writer.w.address);
    await run(h, 'fill_order with donations', [fillIx(h, a, x, writer, writer.stock)], writer.w);
    expect(amount(h.svm, writer.usdc) - w0).toBe(PREMIUM + 7n);
    expect(lockState(h, x).amount).toBe(lockAmount + 3n);
    // the lamports already at the lock address count toward its rent
    expect(ws0 - sol(h, writer.w.address)).toBe(rent(h, x.option) + rent(h, x.optionVault) + rent(h, x.lock) + rent(h, x.lockVault) + h.lastFee - 1_000_000n);
    h.slot(callState(h, x).gateUntil);
    const n0 = amount(h.svm, buyer.once);
    await run(h, 'return_lock with a donation', [returnLockIx(h, x, buyer)], buyer.w);
    expect(amount(h.svm, buyer.once) - n0).toBe(lockAmount + 3n);
    const b = await orderRef(h, 'put', buyer.w.address);
    await run(h, 'place_order', [placeIx(h, b, buyer)], buyer.w);
    await h.donate(donor.usdc, b.vault, h.usdc, TOKEN, donor.w, 5n);
    await h.donate(donor.once, b.once, h.onceMint, h.onceProgram, donor.w, 2n);
    const u0 = amount(h.svm, buyer.usdc), n1 = amount(h.svm, buyer.once);
    await run(h, 'cancel_order with donations', [cancelIx(h, b, buyer)], buyer.w);
    expect(amount(h.svm, buyer.usdc) - u0).toBe(PREMIUM + 5n);
    expect(amount(h.svm, buyer.once) - n1).toBe(lockAmount + 2n);
  });
});

describe('an option made by an order', () => {
  test('lives as any other: offered inside its gate only to a wallet that locks, bought back by its writer with the stock taken out; a put reclaimed after expiry', async () => {
    const h = await Harness.create({ gated: true });
    const buyer = buyerParty(h), writer = await writerParty(h);
    const o = await orderRef(h, 'call', buyer.w.address);
    await run(h, 'place_order', [placeIx(h, o, buyer)], buyer.w);
    const x = await optionRef(h, 'call');
    await run(h, 'fill_order', [fillIx(h, o, x, writer, writer.stock)], writer.w);
    const listing = (await findListingPda(x.option))[0], price = 40_000n;
    await run(h, 'list an order-made call inside its gate', [once.getListInstruction({ holder: buyer.w, call: x.option, listing, price, ...ev(h) })], buyer.w);
    const plain = once.getBuyListedInstruction({ buyer: writer.w, config: h.config, call: x.option, listing, seller: buyer.w.address, usdcMint: h.usdc,
      usdcTokenProgram: TOKEN, paymentSource: writer.usdc, paymentDestination: buyer.usdc, price, ...ev(h) });
    await run(h, 'buy_listed inside its gate', [plain], writer.w, 'InGate');
    const s0 = amount(h.svm, writer.stock);
    await run(h, 'buy back inside its gate (lock_and_buy_listed + close_out)', [
      once.getLockAndBuyListedInstruction({ buyer: writer.w, config: h.config, call: x.option, listing, seller: buyer.w.address,
        lock: (await findResaleLockPda(x.option, writer.w.address))[0], lockVault: (await findResaleLockVaultPda(x.option, writer.w.address))[0],
        onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: writer.once, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
        paymentSource: writer.usdc, paymentDestination: buyer.usdc, price, ...ev(h) }),
      once.getCloseOutInstruction({ writer: writer.w, call: x.option, vault: x.optionVault, mint: o.mint, tokenProgram: o.tokenProgram, destination: writer.stock, ...ev(h) }),
    ], writer.w);
    expect(amount(h.svm, writer.stock) - s0).toBe(LOT);
    expect(callState(h, x).state).toBe(once.CallState.Cancelled);
    expect(lockState(h, x).locker).toBe(buyer.w.address);
    const p = await orderRef(h, 'put', buyer.w.address, { expiryTs: 1_500n });
    await run(h, 'place_order (put)', [placeIx(h, p, buyer)], buyer.w);
    const xp = await optionRef(h, 'put');
    await run(h, 'fill_put_order', [fillPutIx(h, p, xp, writer)], writer.w);
    h.time(1_500n);
    const u0 = amount(h.svm, writer.usdc);
    await run(h, 'reclaim_put on an order-made put', [once.getReclaimPutInstruction({ writer: writer.w, put: xp.option, vault: xp.optionVault, usdcMint: h.usdc,
      usdcTokenProgram: TOKEN, destination: writer.usdc, ...ev(h) })], writer.w);
    expect(amount(h.svm, writer.usdc) - u0).toBe(STRIKE);
  });
});

describe('transaction sizes', () => {
  for (const onceProgram of [TOKEN, TOKEN_2022]) test(`place, fill with the writer's accounts created in the same transaction, and cancel fit (ONCE on ${onceProgram === TOKEN ? 'Token' : 'Token-2022'})`, async () => {
    const h = await Harness.create({ gated: true, onceProgram });
    const buyer = buyerParty(h);
    const fresh = async () => { const w = await generateKeyPairSigner(); h.svm.airdrop(w.address, lamports(10_000_000_000n)); return w; };
    for (const kind of ['call', 'put'] as const) {
      const o = await orderRef(h, kind, buyer.w.address);
      await run(h, `place_order (${kind})`, [placeIx(h, o, buyer)], buyer.w);
      const w = await fresh(), x = await optionRef(h, kind);
      if (kind === 'call') {
        const usdc = await ata(w.address, h.usdc, TOKEN);
        const createUsdc = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: w, owner: w.address, mint: h.usdc, tokenProgram: TOKEN });
        const stock = await h.fundToken(w, o.mint, o.tokenProgram, LOT);
        await run(h, 'fill_order with the writer\'s USDC account created', [createUsdc, fillIx(h, o, x, { w, usdc, once: usdc }, stock)], w);
      } else {
        const funded = await h.fundToken(w, h.usdc, TOKEN, STRIKE);
        await run(h, 'fill_put_order', [fillPutIx(h, o, x, { w, usdc: funded, once: funded })], w);
      }
      const c = await orderRef(h, kind, buyer.w.address);
      await run(h, `place_order (${kind}, to cancel)`, [placeIx(h, c, buyer)], buyer.w);
      await run(h, `cancel_order (${kind})`, [cancelIx(h, c, buyer)], buyer.w);
    }
  });
});
