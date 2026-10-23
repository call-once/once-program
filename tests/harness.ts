import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import { LiteSVM, FailedTransactionMetadata, type TransactionMetadata } from 'litesvm';
import {
  address, generateKeyPairSigner, getAddressEncoder, getAddressDecoder, getProgramDerivedAddress,
  lamports, pipe, createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  signTransactionMessageWithSigners, getCompiledTransactionMessageDecoder,
  unwrapOption, type Address, type Instruction, type TransactionSigner,
} from '@solana/kit';
import * as token from '@solana-program/token-2022';
import { getCreateAssociatedTokenIdempotentInstructionAsync, findAssociatedTokenPda } from '@solana-program/token';
import { getCreateAccountInstruction } from '@solana-program/system';
import * as once from '../client/src/generated/index.js';
import { TOKEN, TOKEN_2022, ATA_PROGRAM, LOADER, USDC, XSTOCKS } from '../client/constants.js';
import { decodeEvents } from '../client/events.js';
import { findConfigPda, findCallPda, findVaultPda, findLockPda, findLockVaultPda, findListingPda, findResaleLockPda, findResaleLockVaultPda } from '../client/pdas.js';

export const PROGRAM = once.ONCE_PROGRAM_ADDRESS;
export const LOT = 1_000_000n, STRIKE = 2_000_000n, PREMIUM = 100_000n;
export const dedicatedMeasurements: Record<string, { label: string; cu: string; events: unknown[] }[]> = {};
export const measurements: Record<string, string[]> = {};
export const eventSamples: Record<string, unknown> = {};
export const accountMeasurements: Record<string, { bytes: number; rent: string }> = {};
export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export const accountData = (svm: LiteSVM, a: Address): Buffer => {
  const account = svm.getAccount(a);
  if (!account.exists) throw new Error(`Missing account ${a}`);
  return Buffer.from(account.data);
};
export const amount = (svm: LiteSVM, a: Address) => svm.getAccount(a).exists ? accountData(svm, a).readBigUInt64LE(64) : 0n;
export const ata = async (owner: Address, mint: Address, program: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: program }))[0];
export type CallRef = { id: bigint; call: Address; vault: Address; lock: Address; lockVault: Address; mint: Address; tokenProgram: Address; source: Address; expiry: bigint };
export type Wallet = Awaited<ReturnType<typeof generateKeyPairSigner>>;

export class Harness {
  svm = new LiteSVM().withTransactionHistory(0n);
  admin!: Wallet; writer!: Wallet; buyer!: Wallet; stranger!: Wallet;
  config!: Address; programData!: Address; eventAuthority!: Address;
  usdc = USDC; onceMint!: Address; onceProgram: Address = TOKEN;
  writerUsdc!: Address; buyerUsdc!: Address; buyerOnce!: Address;
  lastFee = 0n;
  events: ReturnType<typeof decodeEvents> = [];
  receipts: { label: string; cu: string; events: unknown[] }[] = [];

  static async create(options: { gated?: boolean; onceProgram?: Address; initialize?: boolean; delegate?: boolean; binary?: URL } = {}) {
    const h = new Harness();
    const manifest = JSON.parse(readFileSync(new URL('./fixtures/programs.json', import.meta.url), 'utf8'));
    for (const row of manifest) {
      const bytes = readFileSync(new URL(`./fixtures/programs/${row.program}.so`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
      h.svm.addProgram(address(row.program), bytes);
    }
    h.svm.addProgramWithLoader(PROGRAM, readFileSync(options.binary ?? new URL('../target/deploy/once.so', import.meta.url)), LOADER);
    [h.admin, h.writer, h.buyer, h.stranger] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
    for (const w of [h.admin, h.writer, h.buyer, h.stranger]) h.svm.airdrop(w.address, lamports(100_000_000_000n));
    h.programData = (await getProgramDerivedAddress({ programAddress: LOADER, seeds: [getAddressEncoder().encode(PROGRAM)] }))[0];
    const pd = h.svm.getAccount(h.programData);
    if (!pd.exists) throw new Error('Missing ProgramData');
    const bytes = Buffer.from(pd.data);
    bytes[12] = 1;
    bytes.set(getAddressEncoder().encode(h.admin.address), 13);
    h.svm.setAccount({ ...pd, data: bytes });
    h.config = (await findConfigPda())[0];
    h.eventAuthority = (await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ['__event_authority'] }))[0];
    const fixtures = JSON.parse(readFileSync(new URL('./fixtures/mints.json', import.meta.url), 'utf8'));
    for (const [mint, raw] of Object.entries(fixtures.accounts) as [string, any][]) {
      const data = Buffer.from(raw.data[0], 'base64');
      data.set(getAddressEncoder().encode(h.admin.address), 4);
      if (options.delegate && mint === XSTOCKS.NVDAx) {
        for (let offset = 166; offset + 4 <= data.length;) {
          const type = data.readUInt16LE(offset), size = data.readUInt16LE(offset + 2);
          if (type === 12) data.set(getAddressEncoder().encode(h.admin.address), offset + 4);
          if (type === 0) break;
          offset += 4 + size;
        }
      }
      h.svm.setAccount({ address: address(mint), programAddress: address(raw.owner), executable: false,
        lamports: lamports(BigInt(raw.lamports)), data, space: BigInt(data.length) });
    }
    h.svm.warpToSlot(1000n);
    h.time(1_000n);
    h.writerUsdc = await h.fundToken(h.writer, USDC, TOKEN, 100_000_000n);
    h.buyerUsdc = await h.fundToken(h.buyer, USDC, TOKEN, 100_000_000n);
    h.onceProgram = options.onceProgram ?? TOKEN;
    h.onceMint = await h.createMint(h.onceProgram, h.onceProgram === TOKEN_2022 ? 'metadata' : 'classic');
    h.buyerOnce = await h.fundToken(h.buyer, h.onceMint, h.onceProgram, 10_000_000n);
    if (options.initialize !== false) await h.send('init', h.initIx(), h.admin);
    if (options.gated) await h.send('set_once', h.setOnceIx(), h.admin);
    return h;
  }
  eventAccounts() { return { eventAuthority: this.eventAuthority, program: PROGRAM }; }
  initIx(signer: TransactionSigner = this.admin, gateSlots = 151n, lockAmount = 500_000n) {
    return once.getInitInstruction({ authority: signer, deployment: PROGRAM, programData: this.programData,
      config: this.config, usdcMint: this.usdc, admin: this.admin.address, gateSlots, lockAmount, ...this.eventAccounts() });
  }
  setOnceIx(signer: TransactionSigner = this.admin, mint = this.onceMint) {
    return once.getSetOnceInstruction({ admin: signer, config: this.config, onceMint: mint, ...this.eventAccounts() });
  }
  paramsIx(gateSlots: bigint, lockAmount: bigint, signer: TransactionSigner = this.admin) {
    return once.getSetParamsInstruction({ admin: signer, config: this.config, gateSlots, lockAmount, ...this.eventAccounts() });
  }
  configState() { return once.getConfigDecoder().decode(accountData(this.svm, this.config)); }
  callState(c: CallRef) { return once.getCallAccountDecoder().decode(accountData(this.svm, c.call)); }
  lockState(c: CallRef) { return once.getLockDecoder().decode(accountData(this.svm, c.lock)); }
  time(timestamp: bigint) { const clock = this.svm.getClock(); clock.unixTimestamp = timestamp; this.svm.setClock(clock); }
  slot(slot: bigint) { this.svm.warpToSlot(slot); }
  async reference(id = this.configState().nextId, mint: Address = XSTOCKS.NVDAx, expiry = 2000n): Promise<CallRef> {
    const call = (await findCallPda(id))[0];
    const owner = this.svm.getAccount(mint);
    if (!owner.exists) throw new Error('Missing mint');
    return { id, call, vault: (await findVaultPda({ call }))[0], lock: (await findLockPda(call))[0],
      lockVault: (await findLockVaultPda(call))[0], mint, tokenProgram: owner.programAddress,
      source: await ata(this.writer.address, mint, owner.programAddress), expiry };
  }
  async write(mint: Address = XSTOCKS.NVDAx, expiry = 2000n) {
    const c = await this.reference(undefined, mint, expiry);
    if (amount(this.svm, c.source) < LOT * 3n) await this.fundToken(this.writer, mint, c.tokenProgram, LOT * 100n);
    await this.send('write', this.writeIx(c), this.writer);
    return c;
  }
  writeIx(c: CallRef, overrides = {}) {
    return once.getWriteInstruction({ config: this.config, writer: this.writer, call: c.call,
      vault: c.vault, mint: c.mint, source: c.source, tokenProgram: c.tokenProgram,
      id: c.id, lot: LOT, strike: STRIKE, premium: PREMIUM, expiryTs: c.expiry,
      ...this.eventAccounts(), ...overrides });
  }
  buyIx(c: CallRef, overrides = {}) {
    return once.getBuyInstruction({ config: this.config, buyer: this.buyer, call: c.call,
      vault: c.vault, mint: c.mint, tokenProgram: c.tokenProgram, usdcMint: this.usdc,
      usdcTokenProgram: TOKEN, paymentSource: this.buyerUsdc, paymentDestination: this.writerUsdc,
      ...this.eventAccounts(), ...overrides });
  }
  lockBuyIx(c: CallRef, overrides = {}) {
    return once.getLockAndBuyInstruction({ config: this.config, call: c.call, buyer: this.buyer,
      vault: c.vault, mint: c.mint, tokenProgram: c.tokenProgram, usdcMint: this.usdc,
      usdcTokenProgram: TOKEN, paymentSource: this.buyerUsdc, paymentDestination: this.writerUsdc,
      lock: c.lock, lockVault: c.lockVault, onceMint: this.onceMint, onceTokenProgram: this.onceProgram,
      onceSource: this.buyerOnce, ...this.eventAccounts(), ...overrides });
  }
  async callIx(c: CallRef, overrides = {}) {
    return once.getCallInstruction({ config: this.config, holder: this.buyer, call: c.call,
      vault: c.vault, mint: c.mint, tokenProgram: c.tokenProgram, usdcMint: this.usdc,
      usdcTokenProgram: TOKEN, paymentSource: this.buyerUsdc, paymentDestination: this.writerUsdc,
      writer: this.writer.address, destination: await ata(this.buyer.address, c.mint, c.tokenProgram),
      ...this.eventAccounts(), ...overrides });
  }
  cancelIx(c: CallRef, overrides = {}) {
    return once.getCancelInstruction({ writer: this.writer, call: c.call, vault: c.vault,
      mint: c.mint, tokenProgram: c.tokenProgram, destination: c.source,
      ...this.eventAccounts(), ...overrides });
  }
  reclaimIx(c: CallRef, overrides = {}) {
    return once.getReclaimInstruction({ writer: this.writer, call: c.call, vault: c.vault,
      mint: c.mint, tokenProgram: c.tokenProgram, destination: c.source,
      ...this.eventAccounts(), ...overrides });
  }
  returnIx(c: CallRef, overrides = {}) {
    return once.getReturnLockInstruction({ locker: this.buyer, config: this.config,
      lock: c.lock, lockVault: c.lockVault, onceMint: this.onceMint, onceTokenProgram: this.onceProgram,
      destination: this.buyerOnce, ...this.eventAccounts(), ...overrides });
  }
  totals() {
    const balances: Record<string, bigint> = {}, supply: Record<string, bigint> = {};
    for (const program of [TOKEN, TOKEN_2022]) for (const a of this.svm.getProgramAccounts(program)) {
      const d = Buffer.from(a.data);
      if (d.length === 165 || (d.length >= 166 && d[165] === 2)) {
        const mint = getAddressDecoder().decode(d.subarray(0, 32));
        balances[mint] = (balances[mint] ?? 0n) + d.readBigUInt64LE(64);
      } else if (d.length === 82 || (d.length >= 166 && d[165] === 1)) supply[a.address] = d.readBigUInt64LE(36);
    }
    return { balances, supply };
  }
  async transaction(ixs: readonly Instruction[], payer: TransactionSigner) {
    this.svm.expireBlockhash();
    const msg = pipe(createTransactionMessage({ version: 0 }),
      x => setTransactionMessageFeePayerSigner(payer, x),
      x => setTransactionMessageLifetimeUsingBlockhash({ blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 10n ** 12n }, x),
      x => appendTransactionMessageInstructions(ixs, x));
    return signTransactionMessageWithSigners(msg);
  }
  async send(label: string, input: Instruction | readonly Instruction[], payer: TransactionSigner, failure?: string) {
    const ixs = Array.isArray(input) ? input : [input as Instruction];
    const tx = await this.transaction(ixs, payer);
    const keys = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts;
    const before = keys.map(k => this.svm.getAccount(k));
    const totals = this.totals();
    const result = this.svm.sendTransaction(tx);
    if (failure !== undefined) {
      expect(result, label).toBeInstanceOf(FailedTransactionMetadata);
      if (!(result instanceof FailedTransactionMetadata)) throw new Error('Expected failure');
      if (failure) expect(result.meta().logs().join('\n'), label).toContain(`Error Code: ${failure}.`);
      keys.forEach((key, index) => {
        const after = this.svm.getAccount(key), prior = before[index];
        expect(after.exists, `${label}: ${key}`).toEqual(prior.exists);
        if (after.exists && prior.exists) {
          expect(Buffer.from(after.data), `${label}: data ${key}`).toEqual(Buffer.from(prior.data));
          if (key !== payer.address) expect(after.lamports, `${label}: rent ${key}`).toEqual(prior.lamports);
          else expect(prior.lamports - after.lamports, `${label}: fee only`).toBe(5000n * BigInt(Object.keys(tx.signatures).length));
        }
      });
      expect(this.totals()).toEqual(totals);
      return result.meta();
    }
    if (result instanceof FailedTransactionMetadata) throw new Error(`${label}: ${String(result.err())}\n${result.meta().logs().join('\n')}`);
    this.lastFee = keys.reduce((sum, key, index) => {
      const prior = before[index];
      const after = this.svm.getAccount(key);
      return sum + (prior.exists ? prior.lamports : 0n) - (after.exists ? after.lamports : 0n);
    }, 0n);
    const own = ixs.filter(i => i.programAddress === PROGRAM).length;
    if (own) {
      expect(this.totals(), `${label}: token and supply conservation`).toEqual(totals);
      const inner = result.innerInstructions().flat().map(i => ({ programAddress: keys[i.instruction().programIdIndex()], data: i.instruction().data() }));
      const events = decodeEvents(inner);
      expect(events.length, `${label}: event count`).toBe(own);
      const priorByKey = new Map(keys.map((key, i) => [key, before[i]]));
      for (const event of events) {
        const data = event.data;
        eventSamples[event.name] ??= data;
        if (event.name === 'Initialized') {
          expect(event.data).toEqual({ admin: this.configState().admin, usdcMint: this.configState().usdcMint,
            gateSlots: this.configState().gateSlots, lockAmount: this.configState().lockAmount });
        } else if (event.name === 'OnceSet') {
          expect(event.data).toEqual({ onceMint: unwrapOption(this.configState().onceMint), onceTokenProgram: unwrapOption(this.configState().onceTokenProgram) });
        } else if (event.name === 'ParamsSet') {
          expect(event.data).toEqual({ gateSlots: this.configState().gateSlots, lockAmount: this.configState().lockAmount });
        } else if (event.name === 'Listed') {
          const at = (await findListingPda(event.data.call))[0], listing = once.getListingDecoder().decode(accountData(this.svm, at));
          expect(event.data).toEqual({ call: listing.call, id: once.getCallAccountDecoder().decode(accountData(this.svm, listing.call)).id,
            seller: listing.seller, price: listing.price, slot: listing.listedSlot });
        } else if (event.name === 'Unlisted') {
          const at = (await findListingPda(event.data.call))[0], before = priorByKey.get(at);
          if (!before?.exists) throw new Error('Missing pre-unlist account');
          const listing = once.getListingDecoder().decode(before.data);
          expect(event.data).toEqual({ call: listing.call, seller: listing.seller, slot: this.svm.getClock().slot });
          expect(this.svm.getAccount(at).exists).toBe(false);
        } else if (event.name === 'Resold') {
          const at = (await findListingPda(event.data.call))[0], before = priorByKey.get(at), priorCall = priorByKey.get(event.data.call);
          if (!before?.exists || !priorCall?.exists) throw new Error('Missing pre-resale accounts');
          const listing = once.getListingDecoder().decode(before.data), call = once.getCallAccountDecoder().decode(accountData(this.svm, event.data.call));
          const old = once.getCallAccountDecoder().decode(priorCall.data);
          // a take-back later in the same transaction settles the call it bought
          const settled = events.some(e => e.name === 'ClosedOut' && (e.data as any).call === event.data.call) ? { state: call.state, settledSlot: call.settledSlot } : {};
          expect(accountData(this.svm, event.data.call)).toEqual(Buffer.from(once.getCallAccountEncoder().encode({ ...old, holder: call.holder, boughtSlot: this.svm.getClock().slot, ...settled })));
          expect(event.data).toEqual({ call: listing.call, id: call.id, seller: listing.seller, buyer: unwrapOption(call.holder),
            price: listing.price, slot: call.boughtSlot, locked: ixs.some(ix => ix.programAddress === PROGRAM && once.LOCK_AND_BUY_LISTED_DISCRIMINATOR.every((v,i) => ix.data?.[i] === v)) ? this.configState().lockAmount : 0n });
          expect(old.holder).toEqual({ __option: 'Some', value: listing.seller });
          expect(this.svm.getAccount(at).exists).toBe(false);
        } else if ('put' in event.data) {
          const d = event.data as any, put = once.getPutDecoder().decode(accountData(this.svm, d.put));
          const vaultAddress = (await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ['put_vault', getAddressEncoder().encode(d.put)] }))[0];
          const priorVault = priorByKey.get(vaultAddress);
          const held = priorVault?.exists && priorVault.data.length >= 72 ? Buffer.from(priorVault.data).readBigUInt64LE(64) : 0n;
          const common = { put: d.put, id: put.id };
          if (event.name === 'PutWritten') expect(d).toEqual({ ...common, writer: put.writer, mint: put.mint, lot: put.lot, strike: put.strike,
            premium: put.premium, expiryTs: put.expiryTs, writtenSlot: put.writtenSlot, gateUntil: put.gateUntil });
          if (event.name === 'PutBought') {
            const lock = this.svm.getAccount((await findLockPda(d.put))[0]);
            expect(d).toEqual({ ...common, holder: unwrapOption(put.holder), premium: put.premium, slot: put.boughtSlot,
              locked: lock.exists ? once.getLockDecoder().decode(lock.data).amount : 0n });
          }
          if (event.name === 'PutExercised') {
            expect(d).toEqual({ ...common, holder: unwrapOption(put.holder), writer: put.writer, delivered: put.lot, paid: held, slot: put.settledSlot });
            expect(put.state).toBe(once.CallState.Exercised);
          }
          if (event.name === 'PutCancelled') { expect(d).toEqual({ ...common, writer: put.writer, returned: held, slot: put.settledSlot }); expect(put.state).toBe(once.CallState.Cancelled); }
          if (event.name === 'PutReclaimed') { expect(d).toEqual({ ...common, writer: put.writer, holder: put.holder, returned: held, slot: put.settledSlot }); expect(put.state).toBe(once.CallState.Reclaimed); }
          if (event.name === 'PutClosedOut') { expect(d).toEqual({ ...common, writer: put.writer, returned: held, slot: put.settledSlot });
            expect(put.state).toBe(once.CallState.Cancelled); expect(unwrapOption(put.holder)).toBe(put.writer); }
          if (event.name === 'PutListed') {
            const listing = once.getListingDecoder().decode(accountData(this.svm, (await findListingPda(d.put))[0]));
            expect(d).toEqual({ ...common, seller: listing.seller, price: listing.price, slot: listing.listedSlot });
            expect(listing.call).toBe(d.put);
          }
          if (event.name === 'PutResold') {
            const at = (await findListingPda(d.put))[0], before = priorByKey.get(at), priorPut = priorByKey.get(d.put);
            if (!before?.exists || !priorPut?.exists) throw new Error('Missing pre-resale accounts');
            const listing = once.getListingDecoder().decode(before.data), old = once.getPutDecoder().decode(priorPut.data);
            const settled = events.some(e => e.name === 'PutClosedOut' && (e.data as any).put === d.put) ? { state: put.state, settledSlot: put.settledSlot } : {};
            expect(accountData(this.svm, d.put)).toEqual(Buffer.from(once.getPutEncoder().encode({ ...old, holder: put.holder, boughtSlot: this.svm.getClock().slot, ...settled })));
            const rl = this.svm.getAccount((await findResaleLockPda(d.put, d.buyer))[0]);
            expect(d).toEqual({ ...common, seller: listing.seller, buyer: unwrapOption(put.holder), price: listing.price, slot: put.boughtSlot,
              locked: ixs.some(ix => ix.programAddress === PROGRAM && once.LOCK_AND_BUY_LISTED_PUT_DISCRIMINATOR.every((v,i) => ix.data?.[i] === v)) ? this.configState().lockAmount : 0n });
            expect(old.holder).toEqual({ __option: 'Some', value: listing.seller });
            expect(this.svm.getAccount(at).exists).toBe(false);
            void rl;
          }
          if (['PutExercised', 'PutCancelled', 'PutReclaimed', 'PutClosedOut'].includes(event.name)) expect(this.svm.getAccount(vaultAddress).exists).toBe(false);
        } else if (event.name === 'LockReturned' || event.name === 'ResaleLockReturned') {
          const resale = event.name === 'ResaleLockReturned';
          const lockAddress = (await (resale ? findResaleLockPda(event.data.call, event.data.locker) : findLockPda(event.data.call)))[0];
          const vaultAddress = (await (resale ? findResaleLockVaultPda(event.data.call, event.data.locker) : findLockVaultPda(event.data.call)))[0];
          const prior = priorByKey.get(lockAddress), vault = priorByKey.get(vaultAddress);
          if (!prior?.exists || !vault?.exists) throw new Error('Missing pre-return accounts');
          const lock = (resale ? once.getResaleLockDecoder() : once.getLockDecoder()).decode(prior.data);
          expect(event.data).toEqual({ call: lock.call, locker: lock.locker,
            returned: Buffer.from(vault.data).readBigUInt64LE(64), slot: this.svm.getClock().slot });
          expect(this.svm.getAccount(lockAddress).exists).toBe(false);
          expect(this.svm.getAccount(vaultAddress).exists).toBe(false);
        } else {
          const call = once.getCallAccountDecoder().decode(accountData(this.svm, event.data.call));
          const vaultAddress = (await findVaultPda({ call: event.data.call }))[0];
          const priorVault = priorByKey.get(vaultAddress);
          const returned = priorVault?.exists && priorVault.data.length >= 72 ? Buffer.from(priorVault.data).readBigUInt64LE(64) : 0n;
          const common = { call: event.data.call, id: call.id };
          switch (event.name) {
            case 'Written':
              expect(event.data).toEqual({ ...common, writer: call.writer, mint: call.mint,
                lot: call.lot, strike: call.strike, premium: call.premium, expiryTs: call.expiryTs,
                writtenSlot: call.writtenSlot, gateUntil: call.gateUntil });
              break;
            case 'Bought': {
              const lockAddress = (await findLockPda(event.data.call))[0];
              const lock = this.svm.getAccount(lockAddress);
              const locked = lock.exists ? once.getLockDecoder().decode(lock.data).amount : 0n;
              expect(event.data).toEqual({ ...common, holder: unwrapOption(call.holder), premium: call.premium, slot: call.boughtSlot, locked });
              break;
            }
            case 'Exercised':
              expect(event.data).toEqual({ ...common, holder: unwrapOption(call.holder), writer: call.writer,
                strike: call.strike, delivered: returned, slot: call.settledSlot });
              expect(call.state).toBe(once.CallState.Exercised);
              expect(this.svm.getAccount(vaultAddress).exists).toBe(false);
              break;
            case 'Cancelled':
              expect(event.data).toEqual({ ...common, writer: call.writer, returned, slot: call.settledSlot });
              expect(call.state).toBe(once.CallState.Cancelled);
              expect(this.svm.getAccount(vaultAddress).exists).toBe(false);
              break;
            case 'ClosedOut':
              expect(event.data).toEqual({ ...common, writer: call.writer, returned, slot: call.settledSlot });
              expect(call.state).toBe(once.CallState.Cancelled);
              expect(unwrapOption(call.holder)).toBe(call.writer);
              expect(this.svm.getAccount(vaultAddress).exists).toBe(false);
              break;
            case 'Reclaimed':
              expect(event.data).toEqual({ ...common, writer: call.writer, holder: call.holder, returned, slot: call.settledSlot });
              expect(call.state).toBe(once.CallState.Reclaimed);
              expect(this.svm.getAccount(vaultAddress).exists).toBe(false);
              break;
          }
        }
      }
      this.events.push(...events);
      this.receipts.push({ label, cu: result.computeUnitsConsumed().toString(), events });
      (measurements[`${label}:${this.onceProgram === TOKEN ? 'classic' : '2022'}`] ??= []).push(result.computeUnitsConsumed().toString());
    }
    return result;
  }
  async createMint(program: Address, kind: 'classic' | 'metadata' | 'hook' | 'fee' | 'frozen' = 'classic') {
    const mint = await generateKeyPairSigner();
    const extensions: token.ExtensionArgs[] = kind === 'metadata' ? [
      { __kind: 'MetadataPointer', authority: this.admin.address, metadataAddress: mint.address },
      { __kind: 'TokenMetadata', updateAuthority: this.admin.address, mint: mint.address, name: 'Once Test', symbol: 'ONCET', uri: '', additionalMetadata: new Map() },
    ] : [];
    const size = kind === 'hook' ? 234 : kind === 'fee' ? 278 : kind === 'frozen' ? 171 : token.getMintSize(extensions.length ? extensions : undefined);
    const ixs: Instruction[] = [getCreateAccountInstruction({ payer: this.admin, newAccount: mint,
      space: BigInt(kind === 'metadata' ? token.getMintSize(extensions.slice(0, 1)) : size),
      lamports: this.svm.minimumBalanceForRentExemption(BigInt(size)), programAddress: program })];
    if (kind === 'metadata') ixs.push(token.getInitializeMetadataPointerInstruction({ mint: mint.address, authority: this.admin.address, metadataAddress: mint.address }));
    if (kind === 'hook') ixs.push(token.getInitializeTransferHookInstruction({ mint: mint.address, authority: this.admin.address, programId: this.stranger.address }));
    if (kind === 'fee') ixs.push(token.getInitializeTransferFeeConfigInstruction({ mint: mint.address, transferFeeConfigAuthority: this.admin.address, withdrawWithheldAuthority: this.admin.address, transferFeeBasisPoints: 100, maximumFee: 100n }));
    if (kind === 'frozen') ixs.push(token.getInitializeDefaultAccountStateInstruction({ mint: mint.address, state: token.AccountState.Frozen }));
    ixs.push(token.getInitializeMint2Instruction({ mint: mint.address, mintAuthority: this.admin.address, decimals: 8, freezeAuthority: this.admin.address }, { programAddress: program }));
    if (kind === 'metadata') ixs.push(token.getInitializeTokenMetadataInstruction({ metadata: mint.address, updateAuthority: this.admin.address, mint: mint.address,
      mintAuthority: this.admin, name: 'Once Test', symbol: 'ONCET', uri: '' }));
    await this.send(`create_${kind}_mint`, ixs, this.admin);
    return mint.address;
  }
  async fundToken(owner: Wallet, mint: Address, program: Address, value: bigint) {
    const destination = await ata(owner.address, mint, program);
    const prepare: Instruction[] = [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: this.admin, owner: owner.address, mint, tokenProgram: program })];
    if (!this.svm.getAccount(destination).exists && program === TOKEN_2022) {
      const d = accountData(this.svm, mint);
      for (let offset = 166; offset + 4 <= d.length;) {
        const type = d.readUInt16LE(offset), size = d.readUInt16LE(offset + 2);
        if (type === 6 && d[offset + 4] === 2) prepare.push(token.getThawAccountInstruction({ account: destination, mint, owner: this.admin }));
        if (type === 0) break;
        offset += 4 + size;
      }
    }
    await this.send('fund_token', [...prepare,
      token.getMintToCheckedInstruction({ mint, token: destination, mintAuthority: this.admin, amount: value, decimals: accountData(this.svm, mint)[44] }, { programAddress: program })], this.admin);
    return destination;
  }
  async donate(source: Address, destination: Address, mint: Address, program: Address, signer: Wallet, value = 1n) {
    await this.send('donate', token.getTransferCheckedInstruction({ source, destination, mint, authority: signer, amount: value, decimals: accountData(this.svm, mint)[44] }, { programAddress: program }), signer);
  }
  measure(name: string, a: Address) {
    const acc = this.svm.getAccount(a);
    if (!acc.exists) throw new Error('Missing measured account');
    accountMeasurements[name] = { bytes: acc.data.length, rent: acc.lamports.toString() };
  }
}
