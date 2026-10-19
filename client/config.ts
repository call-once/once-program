import { getConfigDecoder, type Config } from './src/generated/accounts/config.js';

/** Read Config accounts from before and after the gate floor was added. */
export function configStateFromBytes(data: Uint8Array): Config {
  if (data.length >= 171) return getConfigDecoder().decode(data);
  const extended = new Uint8Array(data.length + 8);
  extended.set(data);
  return { ...getConfigDecoder().decode(extended), gateFloor: 0n };
}
