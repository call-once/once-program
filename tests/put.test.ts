/* Funded puts: lifecycle, gate, atomic account recovery, mint checks and transaction limits. */
import { afterAll, describe, expect, test } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { getAddressEncoder, getProgramDerivedAddress, generateKeyPairSigner, lamports, unwrapOption, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import * as once from '../client/src/generated/index.js';
import { Harness, amount, ata, LOT, STRIKE, PREMIUM, type Wallet } from './harness.js';
import { TOKEN, TOKEN_2022, USDC, XSTOCKS } from '../client/constants.js';
import { findLockPda, findLockVaultPda } from '../client/pdas.js';
import { writerStockDestination, type ExerciseRpc } from '../client/exercise.js';
import * as t22 from '@solana-program/token-2022';
import { getReallocateInstruction, getEnableMemoTransfersInstruction, ExtensionType } from '@solana-program/token-2022';
import { getCreateAccountInstruction } from '@solana-program/system';
import { address } from '@solana/kit';
import { canReceive, inspectMint } from '../client/mint.js';
import { getSetAuthorityInstruction, AuthorityType } from '@solana-program/token';

const PROGRAM = once.ONCE_PROGRAM_ADDRESS, enc = getAddressEncoder();
const rows: Record<string, unknown>[] = [];
afterAll(() => { writeFileSync(new URL('../target/put-measure.json', import.meta.url), JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? v.toString() : v, 1)); });
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
type PutRef = { id: bigint; put: Address; vault: Address; lock: Address; lockVault: Address; mint: Address; tokenProgram: Address; expiry: bigint };

async function putRef(h: Harness, mint: Address = XSTOCKS.NVDAx, expiry = 2000n, id = h.configState().nextId): Promise<PutRef> {
  const put = (await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ['put', u64(id)] }))[0];
  const vault = (await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ['put_vault', enc.encode(put)] }))[0];
  const m = h.svm.getAccount(mint);
  if (!m.exists) throw new Error('Missing mint');
  return { id, put, vault, lock: (await findLockPda(put))[0], lockVault: (await findLockVaultPda(put))[0], mint, tokenProgram: m.programAddress, expiry };
}
const writePutIx = (h: Harness, p: PutRef, o: Partial<{ lot: bigint; strike: bigint; id: bigint }> = {}) => once.getWritePutInstruction({
  config: h.config, writer: h.writer, put: p.put, vault: p.vault, mint: p.mint, tokenProgram: p.tokenProgram, usdcMint: h.usdc,
  usdcTokenProgram: TOKEN, source: h.writerUsdc, id: o.id ?? p.id, lot: o.lot ?? LOT, strike: o.strike ?? STRIKE, premium: PREMIUM, expiryTs: p.expiry, ...h.eventAccounts() });
const buyPutIx = (h: Harness, p: PutRef, buyer: Wallet = h.buyer, src: Address = h.buyerUsdc) => once.getBuyPutInstruction({
  buyer, config: h.config, put: p.put, vault: p.vault, usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: src, paymentDestination: h.writerUsdc, ...h.eventAccounts() });
const lockBuyPutIx = (h: Harness, p: PutRef) => once.getLockAndBuyPutInstruction({
  config: h.config, put: p.put, buyer: h.buyer, lock: p.lock, lockVault: p.lockVault, onceMint: h.onceMint, onceTokenProgram: h.onceProgram,
  onceSource: h.buyerOnce, vault: p.vault, usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: h.buyerUsdc, paymentDestination: h.writerUsdc, ...h.eventAccounts() });
const svmRpc = (h: Harness): ExerciseRpc => ({
  async getAccount(a) { const acc = h.svm.getAccount(a); return acc.exists ? { programAddress: acc.programAddress, data: Uint8Array.from(acc.data) } : null; },
  async minimumBalance(n) { return h.svm.minimumBalanceForRentExemption(BigInt(n)); },
});
const exerciseIx = (h: Harness, p: PutRef, stockDestination: Address, holder: Wallet = h.buyer, usdc: Address = h.buyerUsdc) => ata(holder.address, p.mint, p.tokenProgram).then(stockSource => once.getExercisePutInstruction({
  holder, put: p.put, vault: p.vault, mint: p.mint, tokenProgram: p.tokenProgram, stockSource, stockDestination,
  usdcMint: h.usdc, usdcTokenProgram: TOKEN, destination: usdc, writer: h.writer.address, ...h.eventAccounts() }));
/* what a client sends: the writer's account made or replaced if needed, then the exercise */
async function exerciseIxs(h: Harness, p: PutRef, holder: Wallet = h.buyer, usdc: Address = h.buyerUsdc) {
  const src = await ata(holder.address, p.mint, p.tokenProgram);
  const d = await writerStockDestination({ writer: h.writer.address, mint: p.mint, tokenProgram: p.tokenProgram, payer: holder,
    avoid: holder.address === h.writer.address ? src : undefined }, svmRpc(h));
  return { ixs: [...d.instructions, await exerciseIx(h, p, d.destination, holder, usdc)], destination: d.destination, fresh: !!d.extraSigner };
}
const cancelPutIx = (h: Harness, p: PutRef) => once.getCancelPutInstruction({ writer: h.writer, put: p.put, vault: p.vault, usdcMint: h.usdc, usdcTokenProgram: TOKEN, destination: h.writerUsdc, ...h.eventAccounts() });
const reclaimPutIx = (h: Harness, p: PutRef) => once.getReclaimPutInstruction({ writer: h.writer, put: p.put, vault: p.vault, usdcMint: h.usdc, usdcTokenProgram: TOKEN, destination: h.writerUsdc, ...h.eventAccounts() });
const putState = (h: Harness, p: PutRef) => once.getPutDecoder().decode(Buffer.from((h.svm.getAccount(p.put) as any).data));

async function run(h: Harness, label: string, ixs: Instruction[], payer: TransactionSigner, failure?: string) {
  ixs = [{programAddress: address('ComputeBudget111111111111111111111111111111'), data: new Uint8Array([2,192,92,21,0])},
    {programAddress: address('ComputeBudget111111111111111111111111111111'), data: new Uint8Array([3,0,0,0,0,0,0,0,0])},...ixs];
  const tx = await h.transaction(ixs, payer);
  const bytes = 1 + 64 * Object.keys(tx.signatures).length + tx.messageBytes.length;
  expect(bytes,label + ': complete signed transaction').toBeLessThanOrEqual(1232);
  const result = await h.send(label, ixs, payer, failure);
  rows.push({ label, bytes, cu: (result as any).computeUnitsConsumed?.() ?? null, error: failure ?? null });
  return result;
}
async function writePut(h: Harness, mint: Address = XSTOCKS.NVDAx, expiry = 2000n) {
  const p = await putRef(h, mint, expiry);
  const writerSol = h.svm.getBalance(h.writer.address)!;
  await run(h, `write_put`, [writePutIx(h, p)], h.writer);
  rows.push({ label: 'put accounts', put: (h.svm.getAccount(p.put) as any).data.length, putRent: (h.svm.getAccount(p.put) as any).lamports,
    vaultRent: (h.svm.getAccount(p.vault) as any).lamports, writerPaid: writerSol - h.svm.getBalance(h.writer.address)! });
  return p;
}

describe('put with the USDC inside', () => {
  test('write: strike moves into the USDC vault; buy only after the gate; exercise swaps the lot for the strike', async () => {
    const h = await Harness.create({ gated: true });
    const w0 = amount(h.svm, h.writerUsdc);
    const p = await writePut(h);
    expect(amount(h.svm, p.vault)).toBe(STRIKE);
    expect(w0 - amount(h.svm, h.writerUsdc)).toBe(STRIKE);
    const s = putState(h, p);
    expect(s).toMatchObject({ id: 0n, writer: h.writer.address, mint: p.mint, lot: LOT, strike: STRIKE, premium: PREMIUM, state: once.CallState.Open });
    expect(s.gateUntil).toBe(s.writtenSlot + 151n);
    await run(h, 'buy_put:in gate', [buyPutIx(h, p)], h.buyer, 'InGate');
    h.slot(s.gateUntil);
    await run(h, 'lock_and_buy_put:after gate', [lockBuyPutIx(h, p)], h.buyer, 'GateClosed');
    const b0 = amount(h.svm, h.buyerUsdc), w1 = amount(h.svm, h.writerUsdc);
    await run(h, 'buy_put', [buyPutIx(h, p)], h.buyer);
    expect(b0 - amount(h.svm, h.buyerUsdc)).toBe(PREMIUM);
    expect(amount(h.svm, h.writerUsdc) - w1).toBe(PREMIUM);
    expect(amount(h.svm, p.vault)).toBe(STRIKE);
    await run(h,'buy_put:already held',[buyPutIx(h,p)],h.buyer,'NotOpen');
    // the holder has no stock yet: the exercise fails as a whole
    await run(h, 'exercise_put:no stock account', (await exerciseIxs(h, p)).ixs, h.buyer, '');
    const stock = await h.fundToken(h.buyer, p.mint, p.tokenProgram, LOT - 1n);
    await run(h, 'exercise_put:short stock', (await exerciseIxs(h, p)).ixs, h.buyer, '');
    await h.donate(await ata(h.admin.address, p.mint, p.tokenProgram).then(async a => (await h.fundToken(h.admin, p.mint, p.tokenProgram, 1n), a)), stock, p.mint, p.tokenProgram, h.admin);
    await run(h, 'exercise_put:stranger', (await exerciseIxs(h, p, h.stranger, h.writerUsdc)).ixs, h.stranger, '');
    const holderUsdc = amount(h.svm, h.buyerUsdc), writerSol = h.svm.getBalance(h.writer.address)!, vaultRent = (h.svm.getAccount(p.vault) as any).lamports;
    await run(h, 'exercise_put (creates writer stock account)', (await exerciseIxs(h, p)).ixs, h.buyer);
    expect(amount(h.svm, stock)).toBe(0n);
    expect(amount(h.svm, await ata(h.writer.address, p.mint, p.tokenProgram))).toBe(LOT);
    expect(amount(h.svm, h.buyerUsdc) - holderUsdc).toBe(STRIKE);
    expect(h.svm.getAccount(p.vault).exists).toBe(false);
    expect(h.svm.getBalance(h.writer.address)! - writerSol).toBe(vaultRent);
    expect(putState(h, p).state).toBe(once.CallState.Exercised);
    await run(h, 'exercise_put:again', (await exerciseIxs(h, p)).ixs, h.buyer, 'AccountNotInitialized');
    await run(h, 'reclaim_put:after exercise', [reclaimPutIx(h, p)], h.writer, 'AccountNotInitialized');
    // a second put on the same stock: the writer's stock account now exists
    const q = await writePut(h);
    h.slot(putState(h, q).gateUntil);
    await run(h, 'buy_put', [buyPutIx(h, q)], h.buyer);
    await h.fundToken(h.buyer, q.mint, q.tokenProgram, LOT);
    await run(h, 'exercise_put (writer stock account exists)', (await exerciseIxs(h, q)).ixs, h.buyer);
  });

  test('inside the gate only with the ONCE lock; the lock returns through return_lock', async () => {
    const h = await Harness.create({ gated: true });
    const p = await writePut(h);
    const o0 = amount(h.svm, h.buyerOnce), lockAmount = h.configState().lockAmount;
    await run(h, 'lock_and_buy_put', [lockBuyPutIx(h, p)], h.buyer);
    expect(o0 - amount(h.svm, h.buyerOnce)).toBe(lockAmount);
    expect(once.getLockDecoder().decode(Buffer.from((h.svm.getAccount(p.lock) as any).data))).toMatchObject({ locker: h.buyer.address, call: p.put, amount: lockAmount, releaseSlot: putState(h, p).gateUntil });
    const returnIx = once.getReturnLockInstruction({ locker: h.buyer, config: h.config, lock: p.lock, lockVault: p.lockVault,
      onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: h.buyerOnce, ...h.eventAccounts() });
    await h.fundToken(h.buyer,p.mint,p.tokenProgram,LOT);
    await run(h,'exercise_put inside the gate',(await exerciseIxs(h,p)).ixs,h.buyer);
    await run(h, 'return_lock:put lock before release', [returnIx], h.buyer, 'LockNotReleased');
    h.slot(putState(h, p).gateUntil);
    await run(h, 'return_lock:put lock (existing instruction)', [returnIx], h.buyer);
    expect(amount(h.svm, h.buyerOnce)).toBe(o0);
  });

  test('cancel while open; reclaim after expiry when held; no exercise after expiry', async () => {
    const h = await Harness.create({ gated: true });
    const p = await writePut(h), q = await writePut(h);
    const w0 = amount(h.svm, h.writerUsdc);
    await run(h, 'cancel_put:stranger', [once.getCancelPutInstruction({ writer: h.stranger, put: p.put, vault: p.vault, usdcMint: h.usdc, usdcTokenProgram: TOKEN, destination: h.buyerUsdc, ...h.eventAccounts() })], h.stranger, 'NotWriter');
    await run(h, 'cancel_put', [cancelPutIx(h, p)], h.writer);
    expect(amount(h.svm, h.writerUsdc) - w0).toBe(STRIKE);
    h.slot(putState(h, q).gateUntil);
    await run(h, 'buy_put', [buyPutIx(h, q)], h.buyer);
    await run(h, 'cancel_put:held', [cancelPutIx(h, q)], h.writer, 'NotOpen');
    await run(h, 'reclaim_put:before expiry', [reclaimPutIx(h, q)], h.writer, 'NotExpired');
    await h.fundToken(h.buyer, q.mint, q.tokenProgram, LOT);
    h.time(2000n);
    await run(h, 'exercise_put:expired', (await exerciseIxs(h, q)).ixs, h.buyer, 'Expired');
    const w1 = amount(h.svm, h.writerUsdc);
    await run(h, 'reclaim_put', [reclaimPutIx(h, q)], h.writer);
    expect(amount(h.svm, h.writerUsdc) - w1).toBe(STRIKE);
    expect(unwrapOption(putState(h, q).holder)).toBe(h.buyer.address);
  });

  test('ids are shared with calls; a put and a call write in one transaction', async () => {
    const h = await Harness.create({ gated: true });
    const c0 = await h.write();
    const p1 = await putRef(h);
    await run(h, 'write_put:wrong id', [writePutIx(h, p1, { id: 5n })], h.writer, '');
    await run(h, 'write_put:zero strike', [writePutIx(h, p1, { strike: 0n })], h.writer, 'InvalidValue');
    await run(h, 'write_put', [writePutIx(h, p1)], h.writer);
    const c2 = await h.reference(), p3 = await putRef(h, XSTOCKS.NVDAx, 2000n, 3n);
    await run(h, 'write + write_put in one transaction', [h.writeIx(c2), writePutIx(h, p3)], h.writer);
    expect([c0.id, p1.id, c2.id, p3.id]).toEqual([0n, 1n, 2n, 3n]);
    expect(h.configState().nextId).toBe(4n);
  });

  test('stock mints the program refuses at write are refused for a put too', async () => {
    const h = await Harness.create({ gated: true });
    for (const kind of ['hook', 'fee', 'frozen'] as const) {
      const mint = await h.createMint(TOKEN_2022, kind);
      const p = await putRef(h, mint);
      await run(h, `write_put:${kind} mint`, [writePutIx(h, p)], h.writer, kind === 'hook' ? 'TransferHookActive' : kind === 'fee' ? 'TransferFeeMint' : 'DefaultStateFrozen');
    }
  });

  test('the writer cannot keep the lot out: a memo-gated, reassigned or own account is replaced in the same transaction', async () => {
    const h = await Harness.create({ gated: true });
    const held = async (mint: Address = XSTOCKS.NVDAx) => {
      const p = await writePut(h, mint);
      h.slot(putState(h, p).gateUntil);
      await run(h, 'buy_put', [buyPutIx(h, p)], h.buyer);
      await h.fundToken(h.buyer, p.mint, p.tokenProgram, LOT);
      return p;
    };
    // Token-2022: the writer asks its ATA for a memo on every incoming transfer
    const p = await held();
    const wAta = await h.fundToken(h.writer, p.mint, p.tokenProgram, 1n);
    await h.send('writer gates its ATA with a memo', [getReallocateInstruction({ token: wAta, payer: h.writer, owner: h.writer, newExtensionTypes: [ExtensionType.MemoTransfer] }),
      getEnableMemoTransfersInstruction({ token: wAta, owner: h.writer })], h.writer);
    await run(h, 'exercise_put:into memo-gated ATA', [await exerciseIx(h, p, wAta)], h.buyer, '');
    const d = await exerciseIxs(h, p);
    expect(d.fresh).toBe(true);
    await run(h, 'exercise_put (fresh writer account, xStock)', d.ixs, h.buyer);
    expect(amount(h.svm, d.destination)).toBe(LOT);
    expect((h.svm.getAccount(d.destination) as any).data.length).toBe(175);
    expect(putState(h, p).state).toBe(once.CallState.Exercised);
    // classic token: the writer hands its ATA to another owner
    const classic = await h.createMint(TOKEN, 'classic');
    const q = await held(classic);
    const cAta = await h.fundToken(h.writer, classic, TOKEN, 1n);
    await h.send('writer reassigns its ATA', getSetAuthorityInstruction({ owned: cAta, owner: h.writer, authorityType: AuthorityType.AccountOwner, newAuthority: h.stranger.address }), h.writer);
    await run(h, 'exercise_put:into reassigned ATA', [await exerciseIx(h, q, cAta)], h.buyer, 'ConstraintTokenOwner');
    const e = await exerciseIxs(h, q);
    expect(e.fresh).toBe(true);
    await run(h, 'exercise_put (fresh writer account, classic)', e.ixs, h.buyer);
    expect(amount(h.svm, e.destination)).toBe(LOT);
    // an account of someone else is refused
    const r = await held();
    await run(h, 'exercise_put:into a stranger account', [await exerciseIx(h, r, await h.fundToken(h.stranger, r.mint, r.tokenProgram, 1n))], h.buyer, 'ConstraintTokenOwner');
    // the writer holds its own put: delivered from its ATA into a fresh account of its own
    const s = await writePut(h, XSTOCKS.AAPLx);
    h.slot(putState(h, s).gateUntil);
    // the premium cannot go from an account into itself (Anchor refuses a duplicate mutable account): a second USDC account of the writer takes it
    const second = (await writerStockDestination({ writer: h.writer.address, mint: h.usdc, tokenProgram: TOKEN, payer: h.writer, avoid: h.writerUsdc }, svmRpc(h)));
    await h.send('second USDC account of the writer', second.instructions, h.writer);
    await run(h, 'buy_put:writer', [once.getBuyPutInstruction({ buyer: h.writer, config: h.config, put: s.put, vault: s.vault, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
      paymentSource: h.writerUsdc, paymentDestination: second.destination, ...h.eventAccounts() })], h.writer);
    await h.fundToken(h.writer, s.mint, s.tokenProgram, LOT);
    const own = await ata(h.writer.address, s.mint, s.tokenProgram), before = amount(h.svm, own);
    await run(h, 'exercise_put:writer into its own source', [await exerciseIx(h, s, own, h.writer, h.writerUsdc)], h.writer, '');
    const f = await exerciseIxs(h, s, h.writer, h.writerUsdc);
    expect(f.fresh).toBe(true);
    await run(h, 'exercise_put (writer as holder)', f.ixs, h.writer);
    expect(before - amount(h.svm, own)).toBe(LOT);
    expect(amount(h.svm, f.destination)).toBe(LOT);
  });

  test('a mint that cannot transfer is refused for a put; nothing moves', async () => {
    const h = await Harness.create({ gated: true }), m = await generateKeyPairSigner();
    await h.send('create nontransferable mint', [
      getCreateAccountInstruction({ payer: h.admin, newAccount: m, space: 170n, lamports: h.svm.minimumBalanceForRentExemption(170n), programAddress: TOKEN_2022 }),
      t22.getInitializeNonTransferableMintInstruction({ mint: m.address }),
      t22.getInitializeMint2Instruction({ mint: m.address, decimals: 8, mintAuthority: h.admin.address, freezeAuthority: null })], h.admin);
    const data = Uint8Array.from((h.svm.getAccount(m.address) as any).data);
    expect(inspectMint(TOKEN_2022, data).failures).toEqual([]);
    expect(inspectMint(TOKEN_2022, data, true).failures).toEqual(['NonTransferableMint']);
    const p = await putRef(h, m.address), w0 = amount(h.svm, h.writerUsdc), id0 = h.configState().nextId;
    await run(h, 'write_put:nontransferable mint', [writePutIx(h, p)], h.writer, 'NonTransferableMint');
    expect(amount(h.svm, h.writerUsdc)).toBe(w0);
    expect(h.configState().nextId).toBe(id0);
    expect(h.svm.getAccount(p.put).exists).toBe(false);
  });

  test('a confidential-transfer account of the writer is replaced by a fresh one', async () => {
    const h = await Harness.create({ gated: true }), m = await generateKeyPairSigner();
    await h.send('create confidential mint', [
      getCreateAccountInstruction({ payer: h.admin, newAccount: m, space: 235n, lamports: h.svm.minimumBalanceForRentExemption(235n), programAddress: TOKEN_2022 }),
      t22.getInitializeConfidentialTransferMintInstruction({ mint: m.address, authority: h.admin.address, autoApproveNewAccounts: true, auditorElgamalPubkey: null }),
      t22.getInitializeMint2Instruction({ mint: m.address, decimals: 8, mintAuthority: h.admin.address, freezeAuthority: null })], h.admin);
    const p = await writePut(h, m.address);
    h.slot(putState(h, p).gateUntil);
    await run(h, 'buy_put', [buyPutIx(h, p)], h.buyer);
    await h.fundToken(h.buyer, p.mint, p.tokenProgram, LOT);
    const w = await h.fundToken(h.writer, p.mint, TOKEN_2022, 1n);
    // a PubkeyValidity proof for a fresh ElGamal key (solana-zk-sdk 5.0.1), verified by the zk ElGamal proof program in the same transaction
    const proof = readFileSync(new URL('./fixtures/pubkey-proof.bin', import.meta.url));
    await h.send('writer makes its ATA confidential', [
      getReallocateInstruction({ token: w, payer: h.writer, owner: h.writer, newExtensionTypes: [ExtensionType.ConfidentialTransferAccount] }),
      { programAddress: address('ZkE1Gama1Proof11111111111111111111111111111'), accounts: [], data: Uint8Array.from([4, ...proof]) },
      t22.getConfigureConfidentialTransferAccountInstruction({ token: w, mint: p.mint, authority: h.writer, decryptableZeroBalance: new Uint8Array(36), maximumPendingBalanceCreditCounter: 65536n, proofInstructionOffset: -1 })], h.writer);
    await h.send('writer refuses ordinary credits', t22.getDisableNonConfidentialCreditsInstruction({ token: w, authority: h.writer }), h.writer);
    await run(h, 'exercise_put:into credit-refusing ATA', [await exerciseIx(h, p, w)], h.buyer, '');
    expect(canReceive(Uint8Array.from((h.svm.getAccount(w) as any).data))).toBe(false);
    const d = await exerciseIxs(h, p);
    expect(d.fresh).toBe(true);
    const before = amount(h.svm, h.buyerUsdc);
    await run(h, 'exercise_put (fresh writer account, confidential mint)', d.ixs, h.buyer);
    expect(amount(h.svm, h.buyerUsdc) - before).toBe(STRIKE);
    expect(amount(h.svm, d.destination)).toBe(LOT);
  });


  test('before ONCE registration puts inherit gate_floor; call and put locks cannot open each other', async () => {
    const h = await Harness.create(), p = await writePut(h);
    expect(putState(h,p).gateUntil).toBe(putState(h,p).writtenSlot);
    await run(h,'buy_put:before ONCE',[buyPutIx(h,p)],h.buyer,'OnceNotSet');
    await run(h,'lock_and_buy_put:before ONCE',[lockBuyPutIx(h,p)],h.buyer,'OnceNotSet');
    h.slot(1020n); await h.send('set_once',h.setOnceIx(),h.admin);
    const end = h.configState().gateFloor;
    h.slot(end - 1n); await run(h,'buy_put:gate_floor',[buyPutIx(h,p)],h.buyer,'InGate');
    await run(h,'lock_and_buy_put:gate_floor',[lockBuyPutIx(h,p)],h.buyer);
    const l = h.svm.getAccount(p.lock); if (!l.exists) throw new Error('Missing lock');
    expect(once.getLockDecoder().decode(l.data).releaseSlot).toBe(end);
    const c = await h.write(); await h.send('lock_and_buy',h.lockBuyIx(c),h.buyer);
    h.slot(h.callState(c).gateUntil);
    await h.send('call lock cannot open put vault',once.getReturnLockInstruction({locker:h.buyer,config:h.config,lock:c.lock,lockVault:p.lockVault,onceMint:h.onceMint,onceTokenProgram:h.onceProgram,destination:h.buyerOnce,...h.eventAccounts()}),h.buyer,'');
    await h.send('put lock cannot open call vault',once.getReturnLockInstruction({locker:h.buyer,config:h.config,lock:p.lock,lockVault:c.lockVault,onceMint:h.onceMint,onceTokenProgram:h.onceProgram,destination:h.buyerOnce,...h.eventAccounts()}),h.buyer,'');
    await h.send('return call lock',h.returnIx(c),h.buyer);
    await h.send('return put lock',once.getReturnLockInstruction({locker:h.buyer,config:h.config,lock:p.lock,lockVault:p.lockVault,onceMint:h.onceMint,onceTokenProgram:h.onceProgram,destination:h.buyerOnce,...h.eventAccounts()}),h.buyer);
    const q = await writePut(h); h.slot(putState(h,q).gateUntil); await run(h,'buy_put:exact gate end',[buyPutIx(h,q)],h.buyer);
  });

  test('exercise, cancel and reclaim pay the entire USDC vault including added funds', async () => {
    const h = await Harness.create({gated:true});
    const source = await h.fundToken(h.admin,h.usdc,TOKEN,100n);
    const p = await writePut(h); h.slot(putState(h,p).gateUntil); await run(h,'buy_put',[buyPutIx(h,p)],h.buyer);
    await h.donate(source,p.vault,h.usdc,TOKEN,h.admin,17n);
    await h.fundToken(h.buyer,p.mint,p.tokenProgram,LOT);
    const before = amount(h.svm,h.buyerUsdc); await run(h,'exercise_put:whole vault',(await exerciseIxs(h,p)).ixs,h.buyer);
    expect(amount(h.svm,h.buyerUsdc)-before).toBe(STRIKE+17n);
    const q = await writePut(h); await h.donate(source,q.vault,h.usdc,TOKEN,h.admin,19n);
    const w0 = amount(h.svm,h.writerUsdc); await run(h,'cancel_put:whole vault',[cancelPutIx(h,q)],h.writer); expect(amount(h.svm,h.writerUsdc)-w0).toBe(STRIKE+19n);
    const r = await writePut(h); await h.donate(source,r.vault,h.usdc,TOKEN,h.admin,23n); h.time(r.expiry);
    await run(h,'buy_put:expiry boundary',[buyPutIx(h,r)],h.buyer,'Expired');
    await run(h,'lock_and_buy_put:expiry boundary',[lockBuyPutIx(h,r)],h.buyer,'Expired');
    const w1 = amount(h.svm,h.writerUsdc); await run(h,'reclaim_put:whole vault',[reclaimPutIx(h,r)],h.writer); expect(amount(h.svm,h.writerUsdc)-w1).toBe(STRIKE+23n);
  });

  test('the existing discriminator and size filter keeps puts out of calls while put locks remain ordinary Locks', async () => {
    const h=await Harness.create({gated:true}),c=await h.write(),p=await writePut(h);
    const cb=h.svm.getAccount(c.call),pb=h.svm.getAccount(p.put); if(!cb.exists||!pb.exists) throw new Error('Missing position');
    const isCall=(data:ArrayLike<number>)=>data.length===211&&once.CALL_ACCOUNT_DISCRIMINATOR.every((v,i)=>data[i]===v);
    expect([cb.data,pb.data].filter(isCall)).toHaveLength(1);expect(isCall(pb.data)).toBe(false);
    expect(Array.from(once.CALL_ACCOUNT_DISCRIMINATOR)).not.toEqual(Array.from(once.PUT_DISCRIMINATOR));
    await run(h,'lock_and_buy_put',[lockBuyPutIx(h,p)],h.buyer);
    const a=h.svm.getAccount(p.lock);if(!a.exists)throw new Error('Missing lock');
    expect(a.data.length).toBe(89);expect(once.LOCK_DISCRIMINATOR.every((v,i)=>a.data[i]===v)).toBe(true);
    expect(once.getLockDecoder().decode(a.data).call).toBe(p.put);expect(p.put).not.toBe(c.call);
  });

  test('all twelve mainnet xStock layouts: write, buy, exercise', async () => {
    const h = await Harness.create({ gated: true });
    for (const [ticker, mint] of Object.entries(XSTOCKS)) {
      const p = await putRef(h, mint as Address);
      await run(h, `write_put:${ticker}`, [writePutIx(h, p)], h.writer);
      h.slot(putState(h, p).gateUntil);
      await run(h, `buy_put:${ticker}`, [buyPutIx(h, p)], h.buyer);
      const stock = await h.fundToken(h.buyer, p.mint, p.tokenProgram, LOT);
      await run(h, `exercise_put:${ticker}`, (await exerciseIxs(h, p)).ixs, h.buyer);
      expect(amount(h.svm, stock)).toBe(0n);
    }
  });
});
