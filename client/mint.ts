import { type Address, getAddressDecoder } from '@solana/kit';
import { TOKEN, TOKEN_2022 } from './constants.js';

export type MintInspection = {
  valid: boolean; failures: string[]; extensions: number[]; decimals?: number;
};

/** Inspect the base mint and the Token-2022 TLV records without UI scaling. */
export function inspectMint(owner: Address, data: Uint8Array): MintInspection {
  const failures: string[] = [];
  const extensions: number[] = [];
  if (owner !== TOKEN && owner !== TOKEN_2022) {
    return { valid: false, failures: ['UnsupportedTokenProgram'], extensions };
  }
  if (data.length < 82 || data[45] !== 1 || (owner === TOKEN && data.length !== 82)) {
    return { valid: false, failures: ['InvalidMint'], extensions };
  }
  if (owner === TOKEN_2022 && data.length !== 82) {
    if (data.length < 166 || data[165] !== 1) failures.push('InvalidMint');
    else {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let offset = 166; offset < data.length;) {
        if (offset + 2 <= data.length && view.getUint16(offset, true) === 0) break;
        if (offset + 4 > data.length) { failures.push('InvalidMint'); break; }
        const type = view.getUint16(offset, true);
        const size = view.getUint16(offset + 2, true);
        offset += 4;
        if (offset + size > data.length || extensions.includes(type)) { failures.push('InvalidMint'); break; }
        extensions.push(type);
        const body = data.subarray(offset, offset + size);
        if (type === 1) failures.push('TransferFeeMint');
        if (type === 6 && (size !== 1 || body[0] !== 1)) failures.push('DefaultStateFrozen');
        if (type === 14 && (size !== 64 || body.subarray(32, 64).some(x => x !== 0))) failures.push('TransferHookActive');
        offset += size;
      }
    }
  }
  return { valid: failures.length === 0, failures, extensions: extensions.sort((a, b) => a - b), decimals: data[44] };
}

export function tokenAccountOwner(data: Uint8Array): Address {
  if (data.length < 165 || data[108] === 0) throw new Error('Invalid token account');
  return getAddressDecoder().decode(data.subarray(32, 64));
}
