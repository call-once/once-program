use crate::error::OnceError;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        default_account_state::DefaultAccountState, transfer_hook::TransferHook,
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::{AccountState, Mint},
};

pub fn validate_mint(account: &AccountInfo<'_>) -> Result<()> {
    if *account.owner == anchor_spl::token::ID {
        return Ok(());
    }
    require_keys_eq!(
        *account.owner,
        anchor_spl::token_2022::ID,
        OnceError::UnsupportedTokenProgram
    );
    let data = account.try_borrow_data()?;
    let mint = StateWithExtensions::<Mint>::unpack(&data)?;
    let extensions = mint.get_extension_types()?;
    require!(
        !extensions.contains(&ExtensionType::TransferFeeConfig),
        OnceError::TransferFeeMint
    );
    if extensions.contains(&ExtensionType::TransferHook) {
        let hook = mint.get_extension::<TransferHook>()?;
        require!(
            Option::<Pubkey>::from(hook.program_id).is_none(),
            OnceError::TransferHookActive
        );
    }
    if extensions.contains(&ExtensionType::DefaultAccountState) {
        require!(
            mint.get_extension::<DefaultAccountState>()?.state == AccountState::Initialized as u8,
            OnceError::DefaultStateFrozen
        );
    }
    Ok(())
}

/// A put takes the stock in at exercise, so its mint must also let the stock move.
pub fn validate_put_mint(account: &AccountInfo<'_>) -> Result<()> {
    validate_mint(account)?;
    if *account.owner == anchor_spl::token_2022::ID {
        let data = account.try_borrow_data()?;
        let mint = StateWithExtensions::<Mint>::unpack(&data)?;
        require!(
            !mint.get_extension_types()?.contains(&ExtensionType::NonTransferable),
            OnceError::NonTransferableMint
        );
    }
    Ok(())
}
