import {
  generateKeyPairSigner, getAddressDecoder, type Address, type Instruction, type KeyPairSigner, type TransactionSigner,
} from '@solana/kit';
import {
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token';
import { getInitializeAccount3Instruction } from '@solana-program/token-2022';
import { getCreateAccountInstruction } from '@solana-program/system';
import { getCallInstruction } from './src/generated/index.js';
import { tokenAccountOwner } from './mint.js';

export type ExerciseAccount = { programAddress: Address; data: Uint8Array };
export type ExerciseRpc = {
  getAccount: (address: Address) => Promise<ExerciseAccount | null>;
  minimumBalance: (size: number) => Promise<bigint>;
};
type Input = Omit<Parameters<typeof getCallInstruction>[0], 'paymentDestination'> & {
  writer: Address; usdcMint: Address; usdcTokenProgram: Address; holder: TransactionSigner;
};
export type WriterPaymentInput = { writer: Address; usdcMint: Address; usdcTokenProgram: Address; payer: TransactionSigner };

/** The writer's USDC account to pay into, recovering a closed or reassigned ATA in the same transaction. */
export async function writerPaymentDestination(input: WriterPaymentInput, rpc: ExerciseRpc): Promise<{
  instructions: Instruction[]; destination: Address; extraSigner?: KeyPairSigner;
}> {
  const { writer, usdcMint: mint, usdcTokenProgram: program, payer } = input;
  const canonical = (await findAssociatedTokenPda({ owner: writer, mint, tokenProgram: program }))[0];
  const account = await rpc.getAccount(canonical);
  if (account === null) {
    return { instructions: [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: writer, mint, tokenProgram: program })], destination: canonical };
  }
  if (account.programAddress !== program || tokenAccountOwner(account.data) !== writer ||
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
  const payment = await writerPaymentDestination({ writer, usdcMint, usdcTokenProgram, payer: holder }, rpc);
  const instructions = [...payment.instructions,
    getCallInstruction({ ...input, paymentDestination: payment.destination }, programAddress ? { programAddress } : undefined)];
  return { instructions, paymentDestination: payment.destination };
}
