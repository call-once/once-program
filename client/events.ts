import { getBase58Encoder, type Address, type ReadonlyUint8Array } from '@solana/kit';
import * as generated from './src/generated/index.js';

const CPI_PREFIX = new Uint8Array([228, 69, 165, 46, 81, 203, 154, 29]);
const decoders = {
  Initialized: generated.getInitializedEventDecoder(),
  OnceSet: generated.getOnceSetEventDecoder(),
  ParamsSet: generated.getParamsSetEventDecoder(),
  Written: generated.getWrittenEventDecoder(),
  Bought: generated.getBoughtEventDecoder(),
  Exercised: generated.getExercisedEventDecoder(),
  Cancelled: generated.getCancelledEventDecoder(),
  Reclaimed: generated.getReclaimedEventDecoder(),
  LockReturned: generated.getLockReturnedEventDecoder(),
};
export type DecodedOnceEvent = { [K in keyof typeof decoders]: {
  name: K; data: ReturnType<(typeof decoders)[K]['decode']>;
} }[keyof typeof decoders];
export type EventInstruction = { programAddress: Address; data: ReadonlyUint8Array | string };

/** Accept resolved inner instructions; RPC data strings use base58. */
export function decodeEvents(instructions: readonly EventInstruction[], program: Address = generated.ONCE_PROGRAM_ADDRESS): DecodedOnceEvent[] {
  const events: DecodedOnceEvent[] = [];
  for (const ix of instructions) {
    if (ix.programAddress !== program) continue;
    const data = typeof ix.data === 'string' ? getBase58Encoder().encode(ix.data) : ix.data;
    if (!CPI_PREFIX.every((x, i) => data[i] === x)) continue;
    let decoded = false;
    for (const [name, decoder] of Object.entries(decoders)) {
      try {
        events.push({ name, data: decoder.decode(data.subarray(8)) } as DecodedOnceEvent);
        decoded = true;
        break;
      } catch { /* A different event discriminator. */ }
    }
    if (!decoded) throw new Error('Unknown or malformed ONCE event');
  }
  return events;
}
