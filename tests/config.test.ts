import { expect, test } from 'vitest';
import { unwrapOption } from '@solana/kit';
import { configStateFromBytes, getConfigEncoder, TOKEN, TOKEN_2022, USDC } from '../client/index.js';

for (const registered of [false, true]) test(`163-byte Config remains readable with ONCE ${registered ? 'Some' : 'None'}`, () => {
  const encoded = getConfigEncoder().encode({ admin: USDC, usdcMint: USDC,
    onceMint: registered ? TOKEN : null, onceTokenProgram: registered ? TOKEN_2022 : null,
    gateSlots: 151n, lockAmount: 1n, nextId: 7n, bump: 255, gateFloor: 0n });
  const legacy = new Uint8Array(163);
  legacy.set(encoded.subarray(0, registered ? 163 : 99));
  const c = configStateFromBytes(legacy);
  expect(c).toMatchObject({ admin: USDC, usdcMint: USDC, gateSlots: 151n, gateFloor: 0n, lockAmount: 1n, nextId: 7n, bump: 255 });
  expect(unwrapOption(c.onceMint)).toBe(registered ? TOKEN : null);
  expect(unwrapOption(c.onceTokenProgram)).toBe(registered ? TOKEN_2022 : null);
});

test('171-byte Config preserves the registered gate floor', () => {
  const bytes = getConfigEncoder().encode({ admin: USDC, usdcMint: USDC, onceMint: TOKEN, onceTokenProgram: TOKEN_2022,
    gateSlots: 151n, gateFloor: 2000n, lockAmount: 1n, nextId: 7n, bump: 255 });
  expect(bytes.length).toBe(171);
  expect(configStateFromBytes(new Uint8Array(bytes)).gateFloor).toBe(2000n);
  expect(() => configStateFromBytes(new Uint8Array(bytes.subarray(0, 162)))).toThrow();
});
