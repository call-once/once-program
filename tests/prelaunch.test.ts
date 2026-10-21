import { expect, test } from 'vitest';
import { unwrapOption } from '@solana/kit';
import { Harness, amount } from './harness.js';
import { TOKEN, TOKEN_2022 } from '../client/constants.js';

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
