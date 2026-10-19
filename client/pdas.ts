import { getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';
import { findCallAccountPda, ONCE_PROGRAM_ADDRESS } from './src/generated/index.js';
export { findConfigPda, findVaultPda } from './src/generated/index.js';

export const findCallPda = (id: bigint | number) => findCallAccountPda({ id });
export const findLockPda = (call: Address) => getProgramDerivedAddress({
  programAddress: ONCE_PROGRAM_ADDRESS, seeds: ['lock', getAddressEncoder().encode(call)],
});
export const findLockVaultPda = (call: Address) => getProgramDerivedAddress({
  programAddress: ONCE_PROGRAM_ADDRESS, seeds: ['lock_vault', getAddressEncoder().encode(call)],
});
