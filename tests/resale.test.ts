/* Listing, sale and independent ONCE returns, including failed-transaction rollback. */
import { afterAll, describe, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { getAddressEncoder, getProgramDerivedAddress, generateKeyPairSigner, lamports, unwrapOption, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import * as once from '../client/src/generated/index.js';
import { Harness, amount, ata, LOT, PREMIUM, type Wallet, type CallRef } from './harness.js';
import { buildExerciseInstructions } from '../client/exercise.js';
import { TOKEN, USDC } from '../client/constants.js';

const PROGRAM = once.ONCE_PROGRAM_ADDRESS, enc = getAddressEncoder();
const rows: Record<string, unknown>[] = [];
const pda = async (...seeds: (string | Address)[]) => (await getProgramDerivedAddress({ programAddress: PROGRAM,
  seeds: seeds.map((s, i) => i === 0 ? s : enc.encode(s as Address)) }))[0];
const listingOf = (c: CallRef) => pda('listing', c.call);
afterAll(() => { writeFileSync(new URL('../target/resale-measure.json', import.meta.url), JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? v.toString() : v, 1)); });

type Party = { w: Wallet; usdc: Address; once: Address };
async function party(h: Harness, usdc = 100_000_000n, onceAmount = 10_000_000n): Promise<Party> {
  const w = await generateKeyPairSigner();
  h.svm.airdrop(w.address, lamports(10_000_000_000n));
  return { w, usdc: await h.fundToken(w, USDC, TOKEN, usdc), once: await h.fundToken(w, h.onceMint, h.onceProgram, onceAmount) };
}
const buyerParty = (h: Harness): Party => ({ w: h.buyer, usdc: h.buyerUsdc, once: h.buyerOnce });

/* Every transaction uses the shared conservation, event and rollback checks. */
async function run(h: Harness, label: string, ixs: Instruction[], payer: TransactionSigner, failure?: string) {
  const tx = await h.transaction(ixs, payer);
  const bytes = 1 + 64 * Object.keys(tx.signatures).length + tx.messageBytes.length;
  const result = await h.send(label, ixs, payer, failure);
  rows.push({ label, bytes, cu: result.computeUnitsConsumed(), error: failure ?? null });
  return { bytes, result };
}

function listIx(h: Harness, c: CallRef, holder: Wallet, listing: Address, price: bigint) {
  return once.getListInstruction({ holder, call: c.call, listing, price, ...h.eventAccounts() });
}
function unlistIx(h: Harness, seller: Wallet, listing: Address) {
  return once.getUnlistInstruction({ seller, listing, ...h.eventAccounts() });
}
function buyListedIx(h: Harness, c: CallRef, buyer: Party, seller: Party, listing: Address, price: bigint) {
  return once.getBuyListedInstruction({ buyer: buyer.w, config: h.config, call: c.call, listing, seller: seller.w.address,
    usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: buyer.usdc, paymentDestination: seller.usdc, price, ...h.eventAccounts() });
}
async function lockBuyListedIx(h: Harness, c: CallRef, buyer: Party, seller: Party, listing: Address, price: bigint) {
  return once.getLockAndBuyListedInstruction({ buyer: buyer.w, config: h.config, call: c.call, listing, seller: seller.w.address,
    lock: await pda('resale_lock', c.call, buyer.w.address), lockVault: await pda('resale_lock_vault', c.call, buyer.w.address),
    onceMint: h.onceMint, onceTokenProgram: h.onceProgram, onceSource: buyer.once,
    usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: buyer.usdc, paymentDestination: seller.usdc, price, ...h.eventAccounts() });
}
async function returnResaleIx(h: Harness, c: CallRef, locker: Party) {
  return once.getReturnResaleLockInstruction({ locker: locker.w, config: h.config, lock: await pda('resale_lock', c.call, locker.w.address),
    lockVault: await pda('resale_lock_vault', c.call, locker.w.address), onceMint: h.onceMint, onceTokenProgram: h.onceProgram,
    destination: locker.once, ...h.eventAccounts() });
}
async function callIxFor(h: Harness, c: CallRef, holder: Party) {
  return once.getCallInstruction({ config: h.config, holder: holder.w, call: c.call, vault: c.vault, mint: c.mint,
    tokenProgram: c.tokenProgram, usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: holder.usdc,
    paymentDestination: h.writerUsdc, writer: h.writer.address, destination: await ata(holder.w.address, c.mint, c.tokenProgram), ...h.eventAccounts() });
}
const gateEnd = (h: Harness, c: CallRef) => { const s = h.callState(c); return s.gateUntil === s.writtenSlot ? h.configState().gateFloor : s.gateUntil; };

describe('resale after the gate', () => {
  test('list, buy at the listed price, holder changes, stock stays, seller paid, listing closed', async () => {
    const h = await Harness.create({ gated: true });
    const c = await h.write();
    h.slot(gateEnd(h, c));
    await h.send('buy', h.buyIx(c), h.buyer);
    const seller = buyerParty(h), next = await party(h), listing = await listingOf(c), price = 250_000n;
    await run(h, 'list:stranger', [listIx(h, c, next.w, listing, price)], next.w, 'NotHolder');
    await run(h, 'list:zero', [listIx(h, c, seller.w, listing, 0n)], seller.w, 'InvalidValue');
    const sellerSol = h.svm.getBalance(seller.w.address)!;
    const l = await run(h, 'list', [listIx(h, c, seller.w, listing, price)], seller.w);
    const rent = h.svm.getAccount(listing).exists ? (h.svm.getAccount(listing) as any).lamports : 0n;
    rows.push({ label: 'listing account', bytes: (h.svm.getAccount(listing) as any).data.length, rent, sellerPaid: sellerSol - h.svm.getBalance(seller.w.address)! });
    expect(once.getListingDecoder().decode((h.svm.getAccount(listing) as any).data)).toMatchObject({ call: c.call, seller: seller.w.address, price });
    const vault0 = amount(h.svm, c.vault), writerUsdc0 = amount(h.svm, h.writerUsdc), sellerUsdc0 = amount(h.svm, seller.usdc), nextUsdc0 = amount(h.svm, next.usdc);
    await run(h, 'buy_listed:stale price', [buyListedIx(h, c, next, seller, listing, price - 1n)], next.w, 'PriceChanged');
    await run(h, 'list:reprice', [listIx(h, c, seller.w, listing, price + 50_000n)], seller.w);
    await run(h, 'buy_listed:old price after reprice', [buyListedIx(h, c, next, seller, listing, price)], next.w, 'PriceChanged');
    const bad = buyListedIx(h,c,next,seller,listing,price+50_000n);
    const replace = (index:number, address:Address) => ({...bad,accounts:bad.accounts.map((a,i)=>i===index?{...a,address}:a)});
    await run(h,'wrong payment destination',[replace(8,h.writerUsdc)],next.w,'NotSeller');
    await run(h,'wrong seller rent recipient',[replace(4,h.stranger.address)],next.w,'NotSeller');
    await run(h,'wrong USDC mint',[replace(5,h.onceMint)],next.w,'WrongMint');
    await run(h,'wrong payment source owner',[replace(7,h.writerUsdc)],next.w,'');
    const sol0 = h.svm.getBalance(seller.w.address)!;
    await run(h, 'buy_listed', [buyListedIx(h, c, next, seller, listing, price + 50_000n)], next.w);
    expect(unwrapOption(h.callState(c).holder)).toBe(next.w.address);
    expect(h.callState(c).state).toBe(once.CallState.Held);
    expect(amount(h.svm, c.vault)).toBe(vault0);
    expect(amount(h.svm, h.writerUsdc)).toBe(writerUsdc0);
    expect(amount(h.svm, seller.usdc) - sellerUsdc0).toBe(price + 50_000n);
    expect(nextUsdc0 - amount(h.svm, next.usdc)).toBe(price + 50_000n);
    expect(h.svm.getAccount(listing).exists).toBe(false);
    expect(h.svm.getBalance(seller.w.address)! - sol0).toBe(rent);
    rows.push({ label: 'seller SOL back on sale (listing rent)', lamports: h.svm.getBalance(seller.w.address)! - sol0 });
    // the old holder can no longer act; the new holder calls once
    await run(h, 'call:old holder', [await callIxFor(h, c, seller)], seller.w, 'NotHolder');
    await run(h, 'call:new holder', [await callIxFor(h, c, next)], next.w);
    expect(h.callState(c).state).toBe(once.CallState.Exercised);
    void l;
  });

  test('a listing left behind by a call or a reclaim cannot sell; the seller takes its rent back', async () => {
    const h = await Harness.create({ gated: true });
    const c = await h.write(undefined, 3000n);
    h.slot(gateEnd(h, c));
    await h.send('buy', h.buyIx(c), h.buyer);
    const seller = buyerParty(h), next = await party(h), listing = await listingOf(c);
    await run(h, 'list', [listIx(h, c, seller.w, listing, 300_000n)], seller.w);
    const exercise = await run(h, 'call + unlist', [await callIxFor(h, c, seller), unlistIx(h, seller.w, listing)], seller.w);
    expect(h.svm.getAccount(listing).exists).toBe(false);
    void exercise;
    const d = await h.write(undefined, 3000n);
    h.slot(gateEnd(h, d));
    await h.send('buy', h.buyIx(d), h.buyer);
    const listing2 = await listingOf(d);
    await run(h, 'list d', [listIx(h, d, seller.w, listing2, 300_000n)], seller.w);
    h.time(3000n);
    await run(h, 'buy_listed:after expiry', [buyListedIx(h, d, next, seller, listing2, 300_000n)], next.w, 'Expired');
    await run(h, 'list:after expiry', [listIx(h, d, seller.w, listing2, 1n)], seller.w, 'Expired');
    await h.send('reclaim', h.reclaimIx(d), h.writer);
    await run(h, 'buy_listed:after reclaim', [buyListedIx(h, d, next, seller, listing2, 300_000n)], next.w, 'NotHeld');
    await run(h, 'unlist:stranger', [unlistIx(h, next.w, listing2)], next.w, 'NotSeller');
    await run(h, 'unlist', [unlistIx(h, seller.w, listing2)], seller.w);
  });
});

describe('resale inside the gate', () => {
  test('inside the gate only a wallet that locks ONCE can buy; both locks come back whole after the gate', async () => {
    const h = await Harness.create({ gated: true });
    const c = await h.write();
    await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
    const first = buyerParty(h), second = await party(h), third = await party(h), listing = await listingOf(c), lockAmount = h.configState().lockAmount;
    await run(h, 'list in gate', [listIx(h, c, first.w, listing, 200_000n)], first.w);
    await run(h, 'buy_listed:in gate', [buyListedIx(h, c, second, first, listing, 200_000n)], second.w, 'InGate');
    const once2 = amount(h.svm, second.once);
    await run(h, 'lock_and_buy_listed', [await lockBuyListedIx(h, c, second, first, listing, 200_000n)], second.w);
    expect(unwrapOption(h.callState(c).holder)).toBe(second.w.address);
    expect(once2 - amount(h.svm, second.once)).toBe(lockAmount);
    expect(h.svm.getAccount(c.lock).exists).toBe(true);
    // the second holder sells again inside the gate; a third lock coexists
    const listingB = await listingOf(c);
    await run(h, 'list again in gate', [listIx(h, c, second.w, listingB, 210_000n)], second.w);
    await run(h, 'lock_and_buy_listed:third', [await lockBuyListedIx(h, c, third, second, listingB, 210_000n)], third.w);
    // the first holder buys it back inside the gate: its resale lock is a different account from its first lock
    await run(h, 'list third', [listIx(h, c, third.w, listingB, 220_000n)], third.w);
    await run(h, 'lock_and_buy_listed:first buys back', [await lockBuyListedIx(h, c, first, third, listingB, 220_000n)], first.w);
    // the second wallet buys it again inside the gate: its resale lock takes a second lock_amount
    await run(h, 'list first', [listIx(h, c, first.w, listingB, 230_000n)], first.w);
    await run(h, 'lock_and_buy_listed:second again', [await lockBuyListedIx(h, c, second, first, listingB, 230_000n)], second.w);
    const secondLock = await pda('resale_lock', c.call, second.w.address), secondVault = await pda('resale_lock_vault', c.call, second.w.address);
    expect(once.getResaleLockDecoder().decode((h.svm.getAccount(secondLock) as any).data)).toMatchObject({ locker: second.w.address, amount: lockAmount * 2n });
    expect(amount(h.svm, secondVault)).toBe(lockAmount * 2n);
    // the unchanged site picks Lock accounts by discriminator and size: only the original lock is a Lock
    const LOCK = Buffer.from(once.LOCK_DISCRIMINATOR), lockLike = h.svm.getProgramAccounts(PROGRAM).filter((a: any) => a.data.length === 89 && Buffer.from(a.data.subarray(0, 8)).equals(LOCK));
    expect(lockLike.map((a: any) => a.address)).toEqual([c.lock]);
    await run(h, 'list second', [listIx(h, c, second.w, listingB, 240_000n)], second.w);
    // nothing returns before the gate ends
    await run(h, 'return_resale_lock:early', [await returnResaleIx(h, c, second)], second.w, 'LockNotReleased');
    h.slot(gateEnd(h, c));
    const late = await party(h);
    await run(h, 'lock_and_buy_listed:after gate', [await lockBuyListedIx(h, c, late, second, listingB, 240_000n)], late.w, 'GateClosed');
    const before = [first, second, third].map(p => amount(h.svm, p.once));
    await h.send('return_lock', h.returnIx(c), h.buyer);
    for (const p of [second, third, first]) await run(h, `return_resale_lock:${p === first ? 'first' : p === second ? 'second' : 'third'}`, [await returnResaleIx(h, c, p)], p.w);
    expect(amount(h.svm, first.once) - before[0]!).toBe(lockAmount * 2n);
    expect(amount(h.svm, second.once) - before[1]!).toBe(lockAmount * 2n);
    expect(amount(h.svm, third.once) - before[2]!).toBe(lockAmount);
    expect(h.svm.getAccount(secondLock).exists).toBe(false);
    // after the gate anyone buys at the price
    const fourth = await party(h, 100_000_000n, 0n);
    await run(h, 'buy_listed:after gate', [buyListedIx(h, c, fourth, second, listingB, 240_000n)], fourth.w);
    expect(unwrapOption(h.callState(c).holder)).toBe(fourth.w.address);
  });

  test('the original return path cannot open a resale lock, and the resale return cannot open the original lock', async () => {
    const h = await Harness.create({ gated: true });
    const c = await h.write();
    await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
    const first = buyerParty(h), second = await party(h), listing = await listingOf(c);
    await run(h, 'list', [listIx(h, c, first.w, listing, 200_000n)], first.w);
    await run(h, 'lock_and_buy_listed', [await lockBuyListedIx(h, c, second, first, listing, 200_000n)], second.w);
    h.slot(gateEnd(h, c));
    const resaleLock = await pda('resale_lock', c.call, second.w.address), resaleVault = await pda('resale_lock_vault', c.call, second.w.address);
    await run(h, 'return_lock on resale lock', [h.returnIx(c, { locker: second.w, lock: resaleLock, lockVault: resaleVault, destination: second.once })], second.w, '');
    await run(h, 'return_resale_lock on original lock', [once.getReturnResaleLockInstruction({ locker: first.w, config: h.config, lock: c.lock,
      lockVault: c.lockVault, onceMint: h.onceMint, onceTokenProgram: h.onceProgram, destination: first.once, ...h.eventAccounts() })], first.w, '');
  });
});


describe('resale deposit rollback', () => {
  test.each([false, true])('USDC failure after a fresh ONCE deposit, existing lock=%s', async existing => {
    const h = await Harness.create({ gated: true }), c = await h.write();
    await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
    const first = buyerParty(h), second = await party(h), listing = await listingOf(c);
    if (existing) {
      await run(h, 'list', [listIx(h,c,first.w,listing,1n)],first.w);
      await run(h, 'lock_and_buy_listed', [await lockBuyListedIx(h,c,second,first,listing,1n)],second.w);
      await run(h, 'list back', [listIx(h,c,second.w,listing,1n)],second.w);
      await run(h, 'lock_and_buy_listed back', [await lockBuyListedIx(h,c,first,second,listing,1n)],first.w);
    }
    await run(h, 'list unaffordable', [listIx(h,c,first.w,listing,10n**15n)],first.w);
    await run(h, 'post-deposit USDC failure', [await lockBuyListedIx(h,c,second,first,listing,10n**15n)],second.w,'');
    const lock = await pda('resale_lock',c.call,second.w.address), vault = await pda('resale_lock_vault',c.call,second.w.address);
    expect(h.svm.getAccount(lock).exists).toBe(existing);
    expect(amount(h.svm,vault)).toBe(existing ? h.configState().lockAmount : 0n);
  });
  test('resale account and event identities differ from the original lock', () => {
    expect(Buffer.from(once.RESALE_LOCK_DISCRIMINATOR)).not.toEqual(Buffer.from(once.LOCK_DISCRIMINATOR));
    expect(Buffer.from(once.RESALE_LOCK_RETURNED_EVENT_DISCRIMINATOR)).not.toEqual(Buffer.from(once.LOCK_RETURNED_EVENT_DISCRIMINATOR));
  });
});


test('the writer can buy a listed call and exercise through a distinct writer payment account', async()=>{
 const h=await Harness.create({gated:true}),c=await h.write();h.slot(gateEnd(h,c));await h.send('buy',h.buyIx(c),h.buyer);
 const seller=buyerParty(h),writer={w:h.writer,usdc:h.writerUsdc,once:h.buyerOnce},listing=await listingOf(c);
 await run(h,'list for writer',[listIx(h,c,seller.w,listing,1n)],seller.w);
 await run(h,'writer buys resale',[buyListedIx(h,c,writer,seller,listing,1n)],h.writer);
 await run(h,'canonical self payment aliases',[await callIxFor(h,c,writer)],h.writer,'ConstraintDuplicateMutableAccount');
 const built=await buildExerciseInstructions({holder:h.writer,writer:h.writer.address,config:h.config,call:c.call,vault:c.vault,mint:c.mint,tokenProgram:c.tokenProgram,
  usdcMint:h.usdc,usdcTokenProgram:TOKEN,paymentSource:h.writerUsdc,destination:c.source,...h.eventAccounts()}, {
  async getAccount(at){const a=h.svm.getAccount(at);return a.exists?{programAddress:a.programAddress,data:new Uint8Array(a.data)}:null},
  async minimumBalance(n){return h.svm.minimumBalanceForRentExemption(BigInt(n))},
 });
 expect(built.paymentDestination).not.toBe(h.writerUsdc);
 await h.send('writer exercises resale',built.instructions,h.writer);expect(h.callState(c).state).toBe(once.CallState.Exercised);
});
