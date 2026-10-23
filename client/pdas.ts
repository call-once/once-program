import { getAddressEncoder, getU64Encoder, getProgramDerivedAddress, type Address } from '@solana/kit';
import { findCallAccountPda, ONCE_PROGRAM_ADDRESS } from './src/generated/index.js';
export { findConfigPda, findVaultPda } from './src/generated/index.js';

export const findCallPda = (id: bigint | number) => findCallAccountPda({ id });
export const findLockPda = (call: Address) => getProgramDerivedAddress({
  programAddress: ONCE_PROGRAM_ADDRESS, seeds: ['lock', getAddressEncoder().encode(call)],
});
export const findLockVaultPda = (call: Address) => getProgramDerivedAddress({
  programAddress: ONCE_PROGRAM_ADDRESS, seeds: ['lock_vault', getAddressEncoder().encode(call)],
});

export const findListingPda = (call: Address) => getProgramDerivedAddress({
  programAddress: ONCE_PROGRAM_ADDRESS, seeds: ['listing', getAddressEncoder().encode(call)],
});
export const findResaleLockPda = (call: Address, locker: Address) => getProgramDerivedAddress({
  programAddress: ONCE_PROGRAM_ADDRESS, seeds: ['resale_lock', getAddressEncoder().encode(call), getAddressEncoder().encode(locker)],
});
export const findResaleLockVaultPda = (call: Address, locker: Address) => getProgramDerivedAddress({
  programAddress: ONCE_PROGRAM_ADDRESS, seeds: ['resale_lock_vault', getAddressEncoder().encode(call), getAddressEncoder().encode(locker)],
});

export const findPutPda = (id: bigint, programAddress = ONCE_PROGRAM_ADDRESS) => getProgramDerivedAddress({ programAddress, seeds: ["put", getU64Encoder().encode(id)] });
export const findPutVaultPda = (put: Address, programAddress = ONCE_PROGRAM_ADDRESS) => getProgramDerivedAddress({ programAddress, seeds: ["put_vault", getAddressEncoder().encode(put)] });
export const findOrderPda = (buyer: Address, nonce: bigint, programAddress = ONCE_PROGRAM_ADDRESS) => getProgramDerivedAddress({ programAddress, seeds: ["order", getAddressEncoder().encode(buyer), getU64Encoder().encode(nonce)] });
export const findOrderVaultPda = (order: Address, programAddress = ONCE_PROGRAM_ADDRESS) => getProgramDerivedAddress({ programAddress, seeds: ["order_vault", getAddressEncoder().encode(order)] });
export const findOrderOncePda = (order: Address, programAddress = ONCE_PROGRAM_ADDRESS) => getProgramDerivedAddress({ programAddress, seeds: ["order_once", getAddressEncoder().encode(order)] });
