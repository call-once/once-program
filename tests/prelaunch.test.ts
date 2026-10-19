import { beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unwrapOption } from '@solana/kit';
import { Harness, accountData, amount, PROGRAM } from './harness.js';
import { TOKEN, TOKEN_2022, LOADER } from '../client/constants.js';

const v1 = new URL('./fixtures/once-v1.so', import.meta.url);
const current = new URL('../target/deploy/once.so', import.meta.url);
beforeAll(() => {
  const bytes = readFileSync(v1);
  // The verifier hashes the executable without its trailing zero padding.
  expect(createHash('sha256').update(bytes.subarray(0, bytes.findLastIndex(b => b !== 0) + 1)).digest('hex'))
    .toBe('a7ecfe427cdaad0c500f9df6b2d6ab45e4436eb6c8aa5abe4e968be5e9d68f23');
  expect(createHash('sha256').update(bytes).digest('hex'))
    .toBe('28ac02da7ae848b71fc7ba9918222026d8a08998b7da3e26b78b714d960e04e7');
});

describe('Config upgrade from v1', () => {
  for (const written of [false, true]) test(`v1 init${written ? ' and an open call' : ' only'} survives upgrade and set_once reallocates to 171 bytes`, async () => {
    const h = await Harness.create({ binary: v1 });
    const c = written ? await h.write() : null;
    expect(accountData(h.svm, h.config).length).toBe(163);
    h.svm.addProgramWithLoader(PROGRAM, readFileSync(current), LOADER);
    expect(h.configState().gateFloor).toBe(0n);
    expect(unwrapOption(h.configState().onceMint)).toBeNull();
    h.slot(2000n);
    await h.send('set_once_after_upgrade', h.setOnceIx(), h.admin);
    const floor = 2151n;
    expect(accountData(h.svm, h.config).length).toBe(171);
    expect(h.configState().gateFloor).toBe(floor);
    expect(unwrapOption(h.configState().onceMint)).toBe(h.onceMint);
    if (c) {
      expect(h.callState(c).gateUntil).toBe(h.callState(c).writtenSlot);
      await h.send('upgraded_buy_in_gate', h.buyIx(c), h.buyer, 'InGate');
      const before = amount(h.svm, h.buyerOnce);
      await h.send('upgraded_lock_buy', h.lockBuyIx(c), h.buyer);
      expect(h.lockState(c).releaseSlot).toBe(floor);
      h.slot(floor - 1n);
      await h.send('upgraded_early_return', h.returnIx(c), h.buyer, 'LockNotReleased');
      h.slot(floor);
      await h.send('upgraded_return', h.returnIx(c), h.buyer);
      expect(amount(h.svm, h.buyerOnce)).toBe(before);
    }
  });
});

test('P3 before ONCE registration both purchases fail; write, cancel and expiry reclaim remain available', async () => {
  const h = await Harness.create();
  const c = await h.write();
  expect(h.configState().gateFloor).toBe(0n);
  await h.send('buy_without_once', h.buyIx(c), h.buyer, 'OnceNotSet');
  await h.send('lock_without_once', h.lockBuyIx(c), h.buyer, 'OnceNotSet');
  await h.send('cancel_without_once', h.cancelIx(c), h.writer);
  const expired = await h.write(undefined, 1001n);
  h.time(expired.expiry);
  await h.send('reclaim_without_once', h.reclaimIx(expired), h.writer);
});

for (const onceProgram of [TOKEN, TOKEN_2022]) for (const sameSlot of [false, true]) {
  test(`P3 pre-registration calls use the registration gate and return the whole lock (${onceProgram}, same slot ${sameSlot})`, async () => {
    const h = await Harness.create({ onceProgram });
    const locked = await h.write(), publicCall = await h.write();
    const written = h.callState(locked);
    expect(written.gateUntil).toBe(written.writtenSlot);
    const registration = sameSlot ? written.writtenSlot : written.writtenSlot + 1000n;
    h.slot(registration);
    await h.send('register_once', h.setOnceIx(), h.admin);
    const floor = registration + 151n;
    expect(h.configState().gateFloor).toBe(floor);
    expect(h.callState(locked).gateUntil).toBe(written.gateUntil);
    await h.send('pre_call_buy_at_registration', h.buyIx(publicCall), h.buyer, 'InGate');
    await h.send('change_params_after_registration', h.paramsIx(20n, 500_000n), h.admin);
    expect(h.configState().gateFloor).toBe(floor);
    h.slot(floor - 1n);
    await h.send('pre_call_buy_last_gate_slot', h.buyIx(publicCall), h.buyer, 'InGate');
    const original = amount(h.svm, h.buyerOnce);
    await h.send('pre_call_lock_buy', h.lockBuyIx(locked), h.buyer);
    expect(h.lockState(locked).releaseSlot).toBe(floor);
    expect(amount(h.svm, h.buyerOnce)).toBe(original - 500_000n);
    await h.send('pre_call_early_return', h.returnIx(locked), h.buyer, 'LockNotReleased');
    h.slot(floor);
    await h.send('pre_call_lock_at_gate_end', h.lockBuyIx(publicCall), h.buyer, 'GateClosed');
    await h.send('pre_call_public_buy', h.buyIx(publicCall), h.buyer);
    await h.send('pre_call_return', h.returnIx(locked), h.buyer);
    expect(amount(h.svm, h.buyerOnce)).toBe(original);
  });
}

test('registration does not extend expiry and an overflowing registration rolls back', async () => {
  const h = await Harness.create();
  const c = await h.write(undefined, 1001n);
  await h.send('overflow_params', h.paramsIx((1n << 64n) - 1n, 500_000n), h.admin);
  await h.send('overflow_registration', h.setOnceIx(), h.admin, 'Overflow');
  expect(h.configState().gateFloor).toBe(0n);
  expect(unwrapOption(h.configState().onceMint)).toBeNull();
  await h.send('restore_params', h.paramsIx(151n, 500_000n), h.admin);
  h.time(c.expiry);
  await h.send('register_after_expiry', h.setOnceIx(), h.admin);
  expect(h.callState(c).expiryTs).toBe(c.expiry);
  await h.send('expired_pre_call_buy', h.buyIx(c), h.buyer, 'Expired');
  await h.send('expired_pre_call_lock', h.lockBuyIx(c), h.buyer, 'Expired');
  await h.send('expired_pre_call_reclaim', h.reclaimIx(c), h.writer);
});
