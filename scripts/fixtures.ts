import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAddressDecoder } from '@solana/kit';
import { XSTOCKS, USDC, TOKEN, TOKEN_2022, ATA_PROGRAM, LOADER } from '../client/constants.js';
import { MAINNET_RPC, rpc } from './rpc.js';

const dir = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));

if (process.argv.includes('--programs-only')) {
  mkdirSync(`${dir}programs`, { recursive: true });
  const manifest = JSON.parse(readFileSync(`${dir}programs.json`, 'utf8'));
  for (const entry of manifest) {
    const file = `${dir}programs/${entry.program}.so`;
    let bytes: Buffer;
    try { bytes = readFileSync(file); } catch {
      const program = await rpc(MAINNET_RPC, 'getAccountInfo', [entry.program, { encoding: 'base64', commitment: 'confirmed' }]);
      if (!program.value?.executable) throw new Error('Token program is missing');
      bytes = Buffer.from(program.value.data[0], 'base64');
      if (program.value.owner === LOADER) {
        const at = getAddressDecoder().decode(bytes.subarray(4, 36));
        const pd = await rpc(MAINNET_RPC, 'getAccountInfo', [at, { encoding: 'base64', commitment: 'confirmed' }]);
        if (pd.value?.owner !== LOADER) throw new Error('Invalid ProgramData');
        const data = Buffer.from(pd.value.data[0], 'base64');
        if (data.readUInt32LE() !== 3) throw new Error('Invalid ProgramData tag');
        bytes = data.subarray(45);
      }
      if (bytes.subarray(entry.bytes).some(x => x !== 0)) throw new Error('Token program has changed');
      bytes = bytes.subarray(0, entry.bytes);
    }
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Token program hash differs: ${entry.program}`);
    writeFileSync(file, bytes);
  }
  console.log('Token program fixtures: 3 hashes match the manifest');
  process.exit(0);
}

mkdirSync(`${dir}programs`, { recursive: true });
const addresses = [...Object.values(XSTOCKS), USDC];
const accounts = await rpc(MAINNET_RPC, 'getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
if (accounts.value.some((a: unknown) => !a)) throw new Error('Missing fixture mint');
writeFileSync(`${dir}mints.json`, JSON.stringify({ slot: accounts.context.slot, accounts: Object.fromEntries(addresses.map((a, i) => [a, accounts.value[i]])) }, null, 2) + '\n');
const manifest = [];
for (const program of [TOKEN, TOKEN_2022, ATA_PROGRAM]) {
  execFileSync('solana', ['program', 'dump', '--url', MAINNET_RPC, program, `${dir}programs/${program}.so`], { env: { ...process.env, NO_DNA: '1' }, stdio: 'pipe' });
  const info = await rpc(MAINNET_RPC, 'getAccountInfo', [program, { encoding: 'base64', commitment: 'confirmed' }]);
  let deploymentSlot: string | null = null;
  if (info.value.owner === LOADER) {
    const data = Buffer.from(info.value.data[0], 'base64');
    const programdata = getAddressDecoder().decode(data.subarray(4, 36));
    const pd = await rpc(MAINNET_RPC, 'getAccountInfo', [programdata, { encoding: 'base64', commitment: 'confirmed' }]);
    deploymentSlot = Buffer.from(pd.value.data[0], 'base64').readBigUInt64LE(4).toString();
  }
  const bytes = readFileSync(`${dir}programs/${program}.so`);
  manifest.push({ program, contextSlot: info.context.slot, deploymentSlot, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
writeFileSync(`${dir}programs.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ mintSlot: accounts.context.slot, mints: addresses.length, programs: manifest }, null, 2));
