import { afterAll, describe, expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { getAddressDecoder, getAddressEncoder, unwrapOption } from '@solana/kit';
import * as token from '@solana-program/token-2022';
import { getTransferSolInstruction } from '@solana-program/system';
import { Harness, amount, ata, accountData, LOT, PREMIUM, STRIKE, measurements, accountMeasurements, eventSamples, dedicatedMeasurements, json } from './harness.js';
import { TOKEN, TOKEN_2022, XSTOCKS } from '../client/constants.js';
import { buildExerciseInstructions } from '../client/exercise.js';
import { inspectMint } from '../client/mint.js';
import { stockMintInstructions, onceMintInstructions } from '../scripts/test-mints.js';
import { CallState } from '../client/src/generated/index.js';

const timeout = 60_000;
afterAll(() => {
  const report = { computeUnits: measurements, accounts: accountMeasurements, eventSamples, dedicatedMeasurements };
  writeFileSync(new URL('../target/measurements.json', import.meta.url), json(report) + '\n');
  console.log('P10 measurements ' + json(report));
});

describe('P1 initialization and configuration', () => {
  test('upgrade authority, duplicate init, positive configuration, admin, one-time mint', async () => {
    const h = await Harness.create({ initialize: false });
    await h.send('foreign_init', h.initIx(h.stranger), h.stranger, 'NotUpgradeAuthority');
    await h.send('zero_gate_init', h.initIx(h.admin, 0n), h.admin, 'InvalidValue');
    await h.send('zero_lock_init', h.initIx(h.admin, 151n, 0n), h.admin, 'InvalidValue');
    await h.send('init', h.initIx(), h.admin);
    expect(h.configState()).toMatchObject({ admin: h.admin.address, usdcMint: h.usdc, gateSlots: 151n, lockAmount: 500_000n, nextId: 0n });
    expect(unwrapOption(h.configState().onceMint)).toBeNull();
    await h.send('duplicate_init', h.initIx(), h.admin, '');
    await h.send('foreign_set_once', h.setOnceIx(h.stranger), h.stranger, 'NotAdmin');
    await h.send('foreign_set_params', h.paramsIx(1n, 1n, h.stranger), h.stranger, 'NotAdmin');
    await h.send('zero_gate_params', h.paramsIx(0n, 1n), h.admin, 'InvalidValue');
    await h.send('zero_lock_params', h.paramsIx(1n, 0n), h.admin, 'InvalidValue');
    await h.send('set_once', h.setOnceIx(), h.admin);
    expect(unwrapOption(h.configState().onceMint)).toBe(h.onceMint);
    expect(unwrapOption(h.configState().onceTokenProgram)).toBe(TOKEN);
    await h.send('repeat_set_once', h.setOnceIx(), h.admin, 'OnceAlreadySet');
    expect(h.events.map(e => e.name)).toEqual(['Initialized', 'OnceSet']);
  }, timeout);
  test('parameters affect only new calls and new locks; old lock returns its original amount', async () => {
    const h = await Harness.create({ gated: true });
    const old = await h.write();
    await h.send('lock_and_buy', h.lockBuyIx(old), h.buyer);
    const oldGate = h.callState(old).gateUntil;
    expect(h.lockState(old).amount).toBe(500_000n);
    await h.send('set_params', h.paramsIx(20n, 700_000n), h.admin);
    expect(h.callState(old).gateUntil).toBe(oldGate);
    expect(h.lockState(old).amount).toBe(500_000n);
    const fresh = await h.write();
    expect(h.callState(fresh).gateUntil - h.callState(fresh).writtenSlot).toBe(20n);
    await h.send('lock_and_buy', h.lockBuyIx(fresh), h.buyer);
    expect(h.lockState(fresh).amount).toBe(700_000n);
    const before = amount(h.svm, h.buyerOnce);
    h.slot(oldGate);
    await h.send('return_lock', h.returnIx(old), h.buyer);
    expect(amount(h.svm, h.buyerOnce) - before).toBe(500_000n);
  }, timeout);
});

test('P2 admin cannot exercise, cancel, reclaim, or return another wallet lock', async () => {
  const h = await Harness.create({ gated: true });
  const c = await h.write();
  await h.send('admin_cancel', h.cancelIx(c, { writer: h.admin }), h.admin, 'NotWriter');
  await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
  const adminUsdc = await h.fundToken(h.admin, h.usdc, TOKEN, 10_000_000n);
  await h.send('admin_call', await h.callIx(c, { holder: h.admin, paymentSource: adminUsdc,
    destination: await ata(h.admin.address, c.mint, c.tokenProgram) }), h.admin, 'NotHolder');
  h.time(c.expiry); h.slot(h.callState(c).gateUntil);
  await h.send('admin_reclaim', h.reclaimIx(c, { writer: h.admin }), h.admin, 'NotWriter');
  await h.send('admin_return', h.returnIx(c, { locker: h.admin }), h.admin, 'NotLocker');
}, timeout);

for (const onceProgram of [TOKEN, TOKEN_2022]) describe(`P3 P5 P9 ONCE ${onceProgram}`, () => {
  test('half-open priority interval and duplicate purchase', async () => {
    const h = await Harness.create({ gated: true, onceProgram });
    const c = await h.write();
    const state = h.callState(c);
    expect(state.gateUntil).toBe(state.writtenSlot + 151n);
    for (let slot = state.writtenSlot; slot < state.gateUntil; slot++) {
      h.slot(slot);
      await h.send('buy_in_gate', h.buyIx(c), h.buyer, 'InGate');
    }
    h.slot(state.gateUntil - 1n);
    await h.send('buy_in_last_slot', h.buyIx(c), h.buyer, 'InGate');
    await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
    expect(h.lockState(c)).toMatchObject({ locker: h.buyer.address, call: c.call, amount: 500_000n, releaseSlot: state.gateUntil });
    await h.send('second_lock_buy', h.lockBuyIx(c), h.buyer, 'NotOpen');
    await h.send('early_return', h.returnIx(c), h.buyer, 'LockNotReleased');
    h.slot(state.gateUntil);
    await h.send('wrong_locker', h.returnIx(c, { locker: h.stranger }), h.stranger, 'NotLocker');
    const before = amount(h.svm, h.buyerOnce), rent = h.svm.getBalance(h.buyer.address)!;
    const lockRent = h.svm.getAccount(c.lock), vaultRent = h.svm.getAccount(c.lockVault);
    if (!lockRent.exists || !vaultRent.exists) throw new Error('Missing lock');
    await h.send('return_lock', h.returnIx(c), h.buyer);
    expect(amount(h.svm, h.buyerOnce) - before).toBe(500_000n);
    expect(h.svm.getBalance(h.buyer.address)! - rent).toBe(lockRent.lamports + vaultRent.lamports - h.lastFee);
    expect(h.svm.getAccount(c.lock).exists).toBe(false);
    expect(h.svm.getAccount(c.lockVault).exists).toBe(false);
    const fresh = await h.write();
    h.slot(h.callState(fresh).gateUntil);
    await h.send('lock_after_gate', h.lockBuyIx(fresh), h.buyer, 'GateClosed');
    await h.send('buy', h.buyIx(fresh), h.buyer);
  }, timeout);
  test('first-slot lock and returns after exercise and reclaim', async () => {
    const h = await Harness.create({ gated: true, onceProgram });
    for (const end of ['exercise', 'reclaim'] as const) {
      h.time(1000n);
      const c = await h.write();
      const original = amount(h.svm, h.buyerOnce);
      await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
      if (end === 'exercise') await h.send('call_new_ata', await h.callIx(c), h.buyer);
      else { h.time(c.expiry); await h.send('reclaim', h.reclaimIx(c), h.writer); }
      h.slot(h.callState(c).gateUntil);
      await h.send('return_lock', h.returnIx(c), h.buyer);
      expect(amount(h.svm, h.buyerOnce)).toBe(original);
    }
  }, timeout);
});

test('P3 calls written before set_once have no interval, including their write slot', async () => {
  const h = await Harness.create();
  const c = await h.write();
  expect(h.callState(c).gateUntil).toBe(h.callState(c).writtenSlot);
  await h.send('lock_without_once', h.lockBuyIx(c), h.buyer, 'OnceNotSet');
  await h.send('set_once', h.setOnceIx(), h.admin);
  await h.send('buy', h.buyIx(c), h.buyer);
}, timeout);

test('P4 expiry boundary, writer and holder authorization, final states', async () => {
  const h = await Harness.create();
  const c = await h.write();
  await h.send('buy', h.buyIx(c), h.buyer);
  await h.send('cancel_held', h.cancelIx(c), h.writer, 'NotOpen');
  await h.send('wrong_writer_cancel', h.cancelIx(c, { writer: h.stranger }), h.stranger, 'NotWriter');
  await h.send('early_reclaim', h.reclaimIx(c), h.writer, 'NotExpired');
  h.time(c.expiry - 1n);
  await h.send('call_new_ata', await h.callIx(c), h.buyer);
  expect(h.callState(c).state).toBe(CallState.Exercised);
  for (const ix of [await h.callIx(c), h.cancelIx(c), h.reclaimIx(c)]) await h.send('settled_again', ix, h.buyer, '');
  h.time(1000n);
  const expired = await h.write();
  await h.send('buy', h.buyIx(expired), h.buyer);
  h.time(expired.expiry);
  await h.send('call_at_expiry', await h.callIx(expired), h.buyer, 'Expired');
  await h.send('reclaim', h.reclaimIx(expired), h.writer);
  expect(h.callState(expired).state).toBe(CallState.Reclaimed);
  h.time(1000n);
  const open = await h.write();
  h.time(open.expiry - 1n);
  await h.send('open_early_reclaim', h.reclaimIx(open), h.writer, 'NotExpired');
  h.time(open.expiry);
  await h.send('buy_at_expiry', h.buyIx(open), h.buyer, 'Expired');
  await h.send('reclaim', h.reclaimIx(open), h.writer);
  h.time(1000n);
  await h.send('set_once', h.setOnceIx(), h.admin);
  const gated = await h.write();
  h.time(gated.expiry);
  await h.send('lock_buy_at_expiry', h.lockBuyIx(gated), h.buyer, 'Expired');
  await h.send('reclaim', h.reclaimIx(gated), h.writer);
  h.time(1000n);
  const cancelled = await h.write();
  await h.send('cancel', h.cancelIx(cancelled), h.writer);
  expect(h.callState(cancelled).state).toBe(CallState.Cancelled);
  for (const settled of [expired, open, gated, cancelled]) {
    await h.send('cancel_settled', h.cancelIx(settled), h.writer, '');
    await h.send('reclaim_settled', h.reclaimIx(settled), h.writer, '');
    await h.send('call_settled', await h.callIx(settled), h.buyer, '');
  }
}, timeout);

test('P6 exact rent refunds, fee losses, and event fields', async () => {
  const h = await Harness.create();
  await h.fundToken(h.writer, XSTOCKS.NVDAx, TOKEN_2022, LOT * 100n);
  const start = h.svm.getBalance(h.writer.address)!;
  const c = await h.write();
  const writeFee = h.lastFee;
  const callRent = h.svm.getAccount(c.call);
  if (!callRent.exists) throw new Error('Missing call');
  expect(h.events.at(-1)).toMatchObject({ name: 'Written', data: { call: c.call, id: c.id, writer: h.writer.address, mint: c.mint,
    lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: c.expiry, writtenSlot: 1000n, gateUntil: 1000n } });
  const buyerBefore = amount(h.svm, h.buyerUsdc), writerBefore = amount(h.svm, h.writerUsdc);
  await h.send('buy', h.buyIx(c), h.buyer);
  expect(h.events.at(-1)).toMatchObject({ name: 'Bought', data: { call: c.call, id: c.id, holder: h.buyer.address, premium: PREMIUM, slot: 1000n, locked: 0n } });
  expect(amount(h.svm, h.buyerUsdc)).toBe(buyerBefore - PREMIUM);
  expect(amount(h.svm, h.writerUsdc)).toBe(writerBefore + PREMIUM);
  await h.send('call_new_ata', await h.callIx(c), h.buyer);
  expect(h.events.at(-1)).toMatchObject({ name: 'Exercised', data: { call: c.call, id: c.id, holder: h.buyer.address, writer: h.writer.address,
    strike: STRIKE, delivered: LOT, slot: 1000n } });
  expect(start - h.svm.getBalance(h.writer.address)!).toBe(writeFee + callRent.lamports);
  expect(amount(h.svm, h.buyerUsdc)).toBe(buyerBefore - PREMIUM - STRIKE);
  expect(amount(h.svm, h.writerUsdc)).toBe(writerBefore + PREMIUM + STRIKE);
  expect(h.svm.getAccount(c.call).exists).toBe(true);
  expect(h.svm.getAccount(c.vault).exists).toBe(false);
  await h.send('set_once', h.setOnceIx(), h.admin);
  const locked = await h.write();
  const buyerStart = h.svm.getBalance(h.buyer.address)!;
  await h.send('lock_and_buy', h.lockBuyIx(locked), h.buyer);
  const buyFee = h.lastFee;
  h.slot(h.callState(locked).gateUntil);
  await h.send('return_lock', h.returnIx(locked), h.buyer);
  expect(buyerStart - h.svm.getBalance(h.buyer.address)!).toBe(buyFee + h.lastFee);
  expect(h.events.at(-1)).toMatchObject({ name: 'LockReturned', data: { call: locked.call, locker: h.buyer.address, returned: 500_000n, slot: h.callState(locked).gateUntil } });
}, timeout);

test('P7 all 12 mainnet mint layouts: exercise, cancellation, expiry reclaim', async () => {
  const h = await Harness.create();
  for (const [symbol, mint] of Object.entries(XSTOCKS)) {
    h.time(1000n);
    const exercise = await h.write(mint);
    const target = await ata(h.buyer.address, mint, TOKEN_2022);
    const before = amount(h.svm, target);
    await h.send('buy', h.buyIx(exercise), h.buyer);
    await h.send('call_new_ata', await h.callIx(exercise), h.buyer);
    expect(amount(h.svm, target) - before, symbol).toBe(LOT);
    const cancelled = await h.write(mint);
    const writerBefore = amount(h.svm, cancelled.source);
    await h.send('cancel', h.cancelIx(cancelled), h.writer);
    expect(amount(h.svm, cancelled.source) - writerBefore).toBe(LOT);
    const expired = await h.write(mint);
    await h.send('buy', h.buyIx(expired), h.buyer);
    h.time(expired.expiry);
    const reclaimBefore = amount(h.svm, expired.source);
    await h.send('reclaim', h.reclaimIx(expired), h.writer);
    expect(amount(h.svm, expired.source) - reclaimBefore).toBe(LOT);
    for (const c of [exercise, cancelled, expired]) expect(h.svm.getAccount(c.vault).exists, symbol).toBe(false);
    console.log(`P7 ${symbol}: write-buy-call / write-cancel / write-buy-expiry-reclaim raw=${LOT}`);
  }
}, timeout);

test('P7 mint rejection matches client inspection; classic mint is accepted', async () => {
  const h = await Harness.create();
  for (const [kind, error] of [['hook', 'TransferHookActive'], ['fee', 'TransferFeeMint'], ['frozen', 'DefaultStateFrozen']] as const) {
    const mint = await h.createMint(TOKEN_2022, kind);
    const source = await h.fundToken(h.writer, mint, TOKEN_2022, LOT * 10n);
    const c = await h.reference(undefined, mint);
    expect(inspectMint(TOKEN_2022, accountData(h.svm, mint)).failures).toContain(error);
    await h.send(`reject_${kind}`, h.writeIx(c, { source }), h.writer, error);
  }
  const mint = await h.createMint(TOKEN);
  const c = await h.write(mint);
  await h.send('buy', h.buyIx(c), h.buyer);
  await h.send('call_classic', await h.callIx(c), h.buyer);
}, timeout);

test('P8a prefunded PDA accounts and P8h id races', async () => {
  const h = await Harness.create({ gated: true });
  const ref = await h.reference();
  await h.fundToken(h.writer, ref.mint, ref.tokenProgram, LOT * 100n);
  await h.send('prefund', [ref.call, ref.vault, ref.lock, ref.lockVault].map(destination =>
    getTransferSolInstruction({ source: h.stranger, destination, amount: h.svm.minimumBalanceForRentExemption(0n) })), h.stranger);
  await h.send('write', h.writeIx(ref), h.writer);
  await h.send('same_id_race', h.writeIx(ref), h.writer, 'IdMismatch');
  await h.send('lock_and_buy', h.lockBuyIx(ref), h.buyer);
  expect(h.configState().nextId).toBe(1n);
  h.slot(h.callState(ref).gateUntil);
  await h.send('return_lock', h.returnIx(ref), h.buyer);
  await h.send('call_new_ata', await h.callIx(ref), h.buyer);
  await h.send('reuse_settled_id', h.writeIx(ref), h.writer, 'IdMismatch');
}, timeout);

test('P8b/c all donated tokens follow the owner and never prevent close', async () => {
  const h = await Harness.create();
  for (const mode of ['call', 'cancel', 'reclaim']) {
    h.time(1000n);
    const c = await h.write();
    const donor = await h.fundToken(h.stranger, c.mint, c.tokenProgram, 7n);
    await h.donate(donor, c.vault, c.mint, c.tokenProgram, h.stranger, 7n);
    if (mode !== 'cancel') await h.send('buy', h.buyIx(c), h.buyer);
    if (mode === 'reclaim') h.time(c.expiry);
    const recipient = mode === 'call' ? await ata(h.buyer.address, c.mint, c.tokenProgram) : c.source;
    const before = amount(h.svm, recipient);
    await h.send(mode, mode === 'call' ? await h.callIx(c) : mode === 'cancel' ? h.cancelIx(c) : h.reclaimIx(c), mode === 'call' ? h.buyer : h.writer);
    expect(amount(h.svm, recipient) - before).toBe(LOT + 7n);
    expect(h.svm.getAccount(c.vault).exists).toBe(false);
  }
  h.time(1000n);
  await h.send('set_once', h.setOnceIx(), h.admin);
  const c = await h.write();
  await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
  const onceDonor = await h.fundToken(h.stranger, h.onceMint, h.onceProgram, 9n);
  await h.donate(onceDonor, c.lockVault, h.onceMint, h.onceProgram, h.stranger, 9n);
  h.slot(h.callState(c).gateUntil);
  const before = amount(h.svm, h.buyerOnce);
  await h.send('return_lock', h.returnIx(c), h.buyer);
  expect(amount(h.svm, h.buyerOnce) - before).toBe(500_009n);
}, timeout);

for (const attack of ['close', 'reassign'] as const) test(`P8d/e atomic exercise when writer payment ATA is ${attack}`, async () => {
  const h = await Harness.create();
  const c = await h.write();
  await h.send('buy', h.buyIx(c), h.buyer);
  if (attack === 'close') {
    const writerFunds = amount(h.svm, h.writerUsdc);
    await h.donate(h.writerUsdc, h.buyerUsdc, h.usdc, TOKEN, h.writer, writerFunds);
    await h.send('close_writer_ata', token.getCloseAccountInstruction({ account: h.writerUsdc, destination: h.writer.address, owner: h.writer }, { programAddress: TOKEN }), h.writer);
  } else await h.send('reassign_writer_ata', token.getSetAuthorityInstruction({ owned: h.writerUsdc, owner: h.writer,
    authorityType: token.AuthorityType.AccountOwner, newAuthority: h.stranger.address }, { programAddress: TOKEN }), h.writer);
  const input = { config: h.config, holder: h.buyer, call: c.call, vault: c.vault,
    mint: c.mint, tokenProgram: c.tokenProgram, usdcMint: h.usdc, usdcTokenProgram: TOKEN,
    paymentSource: h.buyerUsdc, writer: h.writer.address, destination: await ata(h.buyer.address, c.mint, c.tokenProgram), ...h.eventAccounts() };
  const result = await buildExerciseInstructions(input, {
    getAccount: async a => { const acc = h.svm.getAccount(a); return acc.exists ? { programAddress: acc.programAddress, data: new Uint8Array(acc.data) } : null; },
    minimumBalance: async bytes => h.svm.minimumBalanceForRentExemption(BigInt(bytes)),
  });
  expect(result.instructions.length).toBe(attack === 'close' ? 2 : 3);
  expect(h.svm.getAccount(input.destination).exists).toBe(false);
  await h.send('call_recovered', result.instructions, h.buyer);
  const received = accountData(h.svm, result.paymentDestination);
  expect(getAddressDecoder().decode(received.subarray(32, 64))).toBe(h.writer.address);
  expect(amount(h.svm, result.paymentDestination)).toBe(STRIKE);
  expect(amount(h.svm, input.destination)).toBe(LOT);
}, timeout);

test('P8f account substitutions fail without token or state changes', async () => {
  const h = await Harness.create({ gated: true });
  const a = await h.write(), b = await h.write(XSTOCKS.TSLAx);
  const foreignUsdc = await h.fundToken(h.stranger, h.usdc, TOKEN, 10_000_000n);
  const wrongOnce = await h.createMint(TOKEN);
  const wrongOnceSource = await h.fundToken(h.buyer, wrongOnce, TOKEN, 10_000_000n);
  for (const overrides of [
    { vault: b.vault }, { mint: b.mint }, { tokenProgram: TOKEN },
    { paymentDestination: foreignUsdc }, { paymentSource: foreignUsdc },
    { usdcMint: wrongOnce }, { onceMint: wrongOnce, onceSource: wrongOnceSource },
    { onceTokenProgram: TOKEN_2022 }, { lock: b.lock }, { lockVault: b.lockVault },
  ]) await h.send('substitute_lock_buy', h.lockBuyIx(a, overrides), h.buyer, '');
  await h.send('lock_and_buy', h.lockBuyIx(a), h.buyer);
  await h.send('lock_and_buy', h.lockBuyIx(b), h.buyer);
  for (const overrides of [
    { vault: b.vault }, { mint: b.mint }, { tokenProgram: TOKEN },
    { paymentDestination: foreignUsdc }, { paymentSource: foreignUsdc },
    { usdcMint: wrongOnce }, { writer: h.stranger.address },
  ]) await h.send('substitute_call', await h.callIx(a, overrides), h.buyer, '');
  h.slot(h.callState(a).gateUntil);
  for (const overrides of [
    { lockVault: b.lockVault }, { onceMint: wrongOnce }, { onceTokenProgram: TOKEN_2022 },
    { locker: h.stranger }, { destination: wrongOnceSource },
  ]) await h.send('substitute_return', h.returnIx(a, overrides), h.buyer, '');
}, timeout);

test('P8g permanent delegate depletion blocks payment; writer receives the remainder', async () => {
  const h = await Harness.create({ delegate: true });
  const thief = await h.fundToken(h.admin, XSTOCKS.NVDAx, TOKEN_2022, 1n);
  const open = await h.write();
  await h.donate(open.vault, thief, open.mint, open.tokenProgram, h.admin, 11n);
  await h.send('buy_short', h.buyIx(open), h.buyer, 'VaultShort');
  await h.send('cancel_short', h.cancelIx(open), h.writer);
  expect(h.events.at(-1)).toMatchObject({ name: 'Cancelled', data: { returned: LOT - 11n } });
  const held = await h.write();
  await h.send('buy', h.buyIx(held), h.buyer);
  await h.donate(held.vault, thief, held.mint, held.tokenProgram, h.admin, 13n);
  await h.send('call_short', await h.callIx(held), h.buyer, 'VaultShort');
  h.time(held.expiry);
  await h.send('reclaim_short', h.reclaimIx(held), h.writer);
  expect(h.events.at(-1)).toMatchObject({ name: 'Reclaimed', data: { returned: LOT - 13n } });
  h.time(1000n);
  await h.send('set_once', h.setOnceIx(), h.admin);
  const gated = await h.write();
  await h.donate(gated.vault, thief, gated.mint, gated.tokenProgram, h.admin);
  await h.send('lock_buy_short', h.lockBuyIx(gated), h.buyer, 'VaultShort');
}, timeout);

for (const onceProgram of [TOKEN, TOKEN_2022]) test(`P10 measurement ${onceProgram}`, async () => {
  const h = await Harness.create({ gated: true, onceProgram });
  const c = await h.write();
  h.measure('Config', h.config); h.measure('Call', c.call); h.measure('xStock Vault', c.vault);
  await h.send('set_params', h.paramsIx(151n, 500_000n), h.admin);
  await h.send('lock_and_buy', h.lockBuyIx(c), h.buyer);
  h.measure('Lock', c.lock); h.measure(`ONCE ${onceProgram} Lock vault`, c.lockVault);
  await h.send('call_new_ata', await h.callIx(c), h.buyer);
  h.measure('holder xStock ATA', await ata(h.buyer.address, c.mint, c.tokenProgram));
  h.slot(h.callState(c).gateUntil);
  await h.send('return_lock', h.returnIx(c), h.buyer);
  const existing = await h.write();
  h.slot(h.callState(existing).gateUntil);
  await h.send('buy', h.buyIx(existing), h.buyer);
  await h.send('call_existing_ata', await h.callIx(existing), h.buyer);
  const cancelled = await h.write();
  await h.send('cancel', h.cancelIx(cancelled), h.writer);
  const reclaimed = await h.write();
  h.time(reclaimed.expiry);
  await h.send('reclaim', h.reclaimIx(reclaimed), h.writer);
  dedicatedMeasurements[onceProgram] = h.receipts;
}, timeout);


test('Devnet mint builders execute with the eight stock extensions and metadata ONCE', async () => {
  const h = await Harness.create();
  const mint = await stockMintInstructions(h.admin, async bytes => h.svm.minimumBalanceForRentExemption(BigInt(bytes)));
  await h.send('create_stock_test_mint', mint.instructions, h.admin);
  const inspection = inspectMint(TOKEN_2022, accountData(h.svm, mint.mint));
  expect(inspection.valid).toBe(true);
  expect(inspection.extensions).toEqual(inspectMint(TOKEN_2022, accountData(h.svm, XSTOCKS.NVDAx)).extensions);
  expect(inspection.decimals).toBe(8);
  const decoded = token.getMintDecoder().decode(accountData(h.svm, mint.mint));
  const extensions = unwrapOption(decoded.extensions) ?? [];
  const scaled = extensions.find(x => x.__kind === 'ScaledUiAmountConfig');
  expect(scaled && scaled.__kind === 'ScaledUiAmountConfig' && scaled.multiplier).toBe(1.0039);
  const c = await h.write(mint.mint);
  await h.send('buy', h.buyIx(c), h.buyer);
  await h.send('call_test_stock', await h.callIx(c), h.buyer);
  const once = await onceMintInstructions(h.admin, async bytes => h.svm.minimumBalanceForRentExemption(BigInt(bytes)));
  await h.send('create_once_test_mint', once.instructions, h.admin);
  expect(inspectMint(TOKEN_2022, accountData(h.svm, once.mint)).extensions).toEqual([18, 19]);
}, timeout);

test('P6 writer rent identity also holds for cancellation and reclaim', async () => {
  const h = await Harness.create();
  await h.fundToken(h.writer, XSTOCKS.NVDAx, TOKEN_2022, LOT * 100n);
  for (const end of ['cancel', 'reclaim'] as const) {
    h.time(1000n);
    const before = h.svm.getBalance(h.writer.address)!;
    const c = await h.write();
    const writeFee = h.lastFee;
    const call = h.svm.getAccount(c.call);
    if (!call.exists) throw new Error('Missing call');
    if (end === 'reclaim') h.time(c.expiry);
    await h.send(end, end === 'cancel' ? h.cancelIx(c) : h.reclaimIx(c), h.writer);
    expect(before - h.svm.getBalance(h.writer.address)!).toBe(writeFee + h.lastFee + call.lamports);
  }
}, timeout);


test('write rejects nonpositive terms, nonfuture expiry, and a foreign source owner', async () => {
  const h = await Harness.create();
  await h.fundToken(h.writer, XSTOCKS.NVDAx, TOKEN_2022, LOT * 100n);
  const c = await h.reference();
  for (const overrides of [{ lot: 0n }, { strike: 0n }, { premium: 0n }]) {
    await h.send('invalid_terms', h.writeIx(c, overrides), h.writer, 'InvalidValue');
  }
  for (const expiryTs of [999n, 1000n]) await h.send('invalid_expiry', h.writeIx(c, { expiryTs }), h.writer, 'ExpiryNotFuture');
  const foreign = await h.fundToken(h.stranger, c.mint, c.tokenProgram, LOT * 100n);
  await h.send('foreign_write_source', h.writeIx(c, { source: foreign }), h.writer, '');
  expect(h.configState().nextId).toBe(0n);
  expect(h.svm.getAccount(c.call).exists).toBe(false);
  expect(h.svm.getAccount(c.vault).exists).toBe(false);
}, timeout);
