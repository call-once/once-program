import {
  generateKeyPairSigner, getAddressDecoder, type Address, type Instruction, type KeyPairSigner, type TransactionSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import { getInitializeAccount3Instruction } from '@solana-program/token-2022';
import { getCreateAccountInstruction } from '@solana-program/system';
import { getCallInstruction } from './src/generated/index.js';
import { canReceive, tokenAccountOwner, tokenAccountSpace } from './mint.js';

export type ExerciseAccount = { programAddress: Address; data: Uint8Array };
export type ExerciseRpc = {
  getAccount: (address: Address) => Promise<ExerciseAccount | null>;
  minimumBalance: (size: number) => Promise<bigint>;
};
type Input = Omit<Parameters<typeof getCallInstruction>[0], 'paymentDestination'> & {
  writer: Address; usdcMint: Address; usdcTokenProgram: Address; holder: TransactionSigner;
};
export type WriterPaymentInput = { writer: Address; usdcMint: Address; usdcTokenProgram: Address; payer: TransactionSigner; avoid?: Address };

/** The writer's USDC account to pay into, recovering a closed or reassigned ATA in the same transaction. */
export async function writerPaymentDestination(input: WriterPaymentInput, rpc: ExerciseRpc): Promise<{
  instructions: Instruction[]; destination: Address; extraSigner?: KeyPairSigner;
}> {
  const { writer, usdcMint: mint, usdcTokenProgram: program, payer } = input;
  const canonical = (await findAssociatedTokenPda({ owner: writer, mint, tokenProgram: program }))[0];
  const account = await rpc.getAccount(canonical);
  if (account === null && input.avoid !== canonical) {
    return { instructions: [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: writer, mint, tokenProgram: program })], destination: canonical };
  }
  if (input.avoid === canonical || account === null || account.programAddress !== program || tokenAccountOwner(account.data) !== writer ||
      getAddressDecoder().decode(account.data.subarray(0, 32)) !== mint) {
    const fresh = await generateKeyPairSigner();
    // USDC uses an unextended token account; account creation and payment are atomic.
    return { instructions: [
      getCreateAccountInstruction({ payer, newAccount: fresh, space: 165n, lamports: await rpc.minimumBalance(165), programAddress: program }),
      getInitializeAccount3Instruction({ account: fresh.address, mint, owner: writer }, { programAddress: program }),
    ], destination: fresh.address, extraSigner: fresh };
  }
  return { instructions: [], destination: canonical };
}

/** Build an atomic exercise, recovering a closed or reassigned payment ATA. */
export async function buildExerciseInstructions(input: Input, rpc: ExerciseRpc, programAddress?: Address): Promise<{
  instructions: Instruction[]; paymentDestination: Address;
}> {
  const { writer, usdcMint, usdcTokenProgram, holder } = input;
  const source = input.paymentSource;
  const sourceAddress = typeof source === 'string' ? source : source && 'address' in source ? source.address : source?.[0];
  const payment = await writerPaymentDestination({ writer, usdcMint, usdcTokenProgram, payer: holder, avoid: holder.address === writer ? sourceAddress : undefined }, rpc);
  const instructions = [...payment.instructions,
    getCallInstruction({ ...input, paymentDestination: payment.destination }, programAddress ? { programAddress } : undefined)];
  return { instructions, paymentDestination: payment.destination };
}

export type WriterStockInput = { writer: Address; mint: Address; tokenProgram: Address; payer: TransactionSigner; avoid?: Address };

/** The put writer's stock account to deliver into: the ATA, made if missing, or a fresh account when the ATA cannot take the lot. */
export async function writerStockDestination(input: WriterStockInput, rpc: ExerciseRpc): Promise<{
  instructions: Instruction[]; destination: Address; extraSigner?: KeyPairSigner;
}> {
  const { writer, mint, tokenProgram: program, payer } = input;
  const canonical = (await findAssociatedTokenPda({ owner: writer, mint, tokenProgram: program }))[0];
  const account = await rpc.getAccount(canonical);
  if (account === null && input.avoid !== canonical) {
    return { instructions: [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: writer, mint, tokenProgram: program })], destination: canonical };
  }
  if (input.avoid === canonical || account === null || account.programAddress !== program || tokenAccountOwner(account.data) !== writer ||
      getAddressDecoder().decode(account.data.subarray(0, 32)) !== mint || !canReceive(account.data)) {
    const mintAccount = await rpc.getAccount(mint);
    if (!mintAccount) throw new Error('Missing mint');
    const space = tokenAccountSpace(program, mintAccount.data);
    const fresh = await generateKeyPairSigner();
    return { instructions: [
      getCreateAccountInstruction({ payer, newAccount: fresh, space: BigInt(space), lamports: await rpc.minimumBalance(space), programAddress: program }),
      getInitializeAccount3Instruction({ account: fresh.address, mint, owner: writer }, { programAddress: program }),
    ], destination: fresh.address, extraSigner: fresh };
  }
  return { instructions: [], destination: canonical };
}
