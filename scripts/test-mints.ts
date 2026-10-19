import { generateKeyPairSigner, type Instruction, type TransactionSigner } from '@solana/kit';
import * as token from '@solana-program/token-2022';
import { getCreateAccountInstruction } from '@solana-program/system';
import { SYSTEM, TOKEN_2022 } from '../client/constants.js';

/** Token-2022 test mint with the eight extension kinds used by xStocks. */
export async function stockMintInstructions(authority: TransactionSigner, minimumBalance: (size: number) => Promise<bigint>) {
  const mint = await generateKeyPairSigner();
  const owner = authority.address;
  const metadata: token.ExtensionArgs = { __kind: 'TokenMetadata', updateAuthority: owner,
    mint: mint.address, name: 'Stock Test', symbol: 'STOCKT', uri: '', additionalMetadata: new Map() };
  const extensions: token.ExtensionArgs[] = [
    { __kind: 'ConfidentialTransferMint', authority: owner, autoApproveNewAccounts: false, auditorElgamalPubkey: null },
    { __kind: 'DefaultAccountState', state: token.AccountState.Initialized },
    { __kind: 'MetadataPointer', authority: owner, metadataAddress: mint.address },
    { __kind: 'PausableConfig', authority: owner, paused: false },
    { __kind: 'PermanentDelegate', delegate: owner },
    { __kind: 'ScaledUiAmountConfig', authority: owner, multiplier: 1.0039, newMultiplierEffectiveTimestamp: 0n, newMultiplier: 1.0039 },
    { __kind: 'TransferHook', authority: owner, programId: SYSTEM },
  ];
  const instructions: Instruction[] = [
    getCreateAccountInstruction({ payer: authority, newAccount: mint,
      space: BigInt(token.getMintSize(extensions)), lamports: await minimumBalance(token.getMintSize([...extensions, metadata])), programAddress: TOKEN_2022 }),
    token.getInitializeConfidentialTransferMintInstruction({ mint: mint.address, authority: owner, autoApproveNewAccounts: false, auditorElgamalPubkey: null }),
    token.getInitializeDefaultAccountStateInstruction({ mint: mint.address, state: token.AccountState.Initialized }),
    token.getInitializeMetadataPointerInstruction({ mint: mint.address, authority: owner, metadataAddress: mint.address }),
    token.getInitializePausableConfigInstruction({ mint: mint.address, authority: owner }),
    token.getInitializePermanentDelegateInstruction({ mint: mint.address, delegate: owner }),
    token.getInitializeScaledUiAmountMintInstruction({ mint: mint.address, authority: owner, multiplier: 1.0039 }),
    token.getInitializeTransferHookInstruction({ mint: mint.address, authority: owner, programId: null }),
    token.getInitializeMint2Instruction({ mint: mint.address, mintAuthority: owner, freezeAuthority: owner, decimals: 8 }),
    token.getInitializeTokenMetadataInstruction({ metadata: mint.address, updateAuthority: owner,
      mint: mint.address, mintAuthority: authority, name: 'Stock Test', symbol: 'STOCKT', uri: '' }),
  ];
  return { mint: mint.address, instructions };
}

export async function onceMintInstructions(authority: TransactionSigner, minimumBalance: (size: number) => Promise<bigint>) {
  const mint = await generateKeyPairSigner();
  const pointer: token.ExtensionArgs = { __kind: 'MetadataPointer', authority: authority.address, metadataAddress: mint.address };
  const metadata: token.ExtensionArgs = { __kind: 'TokenMetadata', updateAuthority: authority.address,
    mint: mint.address, name: 'Once Test', symbol: 'ONCET', uri: '', additionalMetadata: new Map() };
  return { mint: mint.address, instructions: [
    getCreateAccountInstruction({ payer: authority, newAccount: mint,
      space: BigInt(token.getMintSize([pointer])), lamports: await minimumBalance(token.getMintSize([pointer, metadata])), programAddress: TOKEN_2022 }),
    token.getInitializeMetadataPointerInstruction({ mint: mint.address, authority: authority.address, metadataAddress: mint.address }),
    token.getInitializeMint2Instruction({ mint: mint.address, mintAuthority: authority.address, decimals: 8 }),
    token.getInitializeTokenMetadataInstruction({ metadata: mint.address, updateAuthority: authority.address,
      mint: mint.address, mintAuthority: authority, name: 'Once Test', symbol: 'ONCET', uri: '' }),
  ] as Instruction[] };
}
