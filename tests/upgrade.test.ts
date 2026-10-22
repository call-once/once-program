/* Compatibility rehearsal with an authenticated previous executable supplied by the caller. */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { unwrapOption, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import * as once from '../client/src/generated/index.js';
import { Harness, amount } from './harness.js';
import { LOADER, TOKEN, USDC } from '../client/constants.js';

const OLD = process.env.ONCE_PREV_SO;
test.skipIf(!OLD)('previous Config, calls and original locks keep working after replacement', async () => {
  const previous = resolve(OLD!);
  expect(execFileSync('solana-verify', ['get-executable-hash', previous], {encoding:'utf8'}).trim()).toBe('bf4e1277c0cb4abf89dcbce4e1fd49d379760ff87f098010189b021c069207c9');
  const h = await Harness.create({ gated: true, binary: pathToFileURL(previous) });
  const held = await h.write(), gated = await h.write(), open = await h.write();
  await h.send('lock_and_buy', h.lockBuyIx(gated), h.buyer);           // lock made by the old binary
  h.slot(h.callState(held).gateUntil);
  await h.send('buy', h.buyIx(held), h.buyer);
  // a list instruction does not exist in the deployed binary
  const listing = (await getProgramDerivedAddress({ programAddress: once.ONCE_PROGRAM_ADDRESS, seeds: ['listing', getAddressEncoder().encode(held.call)] }))[0];
  const listIx = once.getListInstruction({ holder: h.buyer, call: held.call, listing, price: 1n, ...h.eventAccounts() });
  await h.send('list unavailable before replacement', listIx, h.buyer, '');
  // Same address and preserved ProgramData authority.
  const pd = h.svm.getAccount(h.programData) as any, authority = Buffer.from(pd.data).subarray(12, 45);
  h.svm.addProgramWithLoader(once.ONCE_PROGRAM_ADDRESS, readFileSync(new URL('../target/deploy/once.so', import.meta.url)), LOADER);
  const pd2 = h.svm.getAccount(h.programData) as any, d2 = Buffer.from(pd2.data); d2.set(authority, 12); h.svm.setAccount({ ...pd2, data: d2 });
  expect(h.configState().nextId).toBe(3n);
  await h.send('list after replacement', listIx, h.buyer);
  const next = await (await import('@solana/kit')).generateKeyPairSigner();
  h.svm.airdrop(next.address, 10_000_000_000n as any);
  const nextUsdc = await h.fundToken(next, USDC, TOKEN, 10_000_000n);
  await h.send('buy_listed after replacement', [once.getBuyListedInstruction({ buyer: next, config: h.config, call: held.call, listing, seller: h.buyer.address,
    usdcMint: h.usdc, usdcTokenProgram: TOKEN, paymentSource: nextUsdc, paymentDestination: h.buyerUsdc, price: 1n, ...h.eventAccounts() })], next);
  expect(unwrapOption(h.callState(held).holder)).toBe(next.address);
  h.slot(h.callState(gated).gateUntil);
  const o = amount(h.svm, h.buyerOnce);
  await h.send('return_lock', h.returnIx(gated), h.buyer);              // old lock, new code
  expect(amount(h.svm, h.buyerOnce) - o).toBe(h.configState().lockAmount);
  await h.send('cancel', h.cancelIx(open), h.writer);                    // old open call, new code
  await h.send('call', await h.callIx(gated), h.buyer);                  // old held call, new code
});
