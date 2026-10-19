use anchor_lang::prelude::*;

#[error_code]
pub enum OnceError {
    #[msg("Only the program upgrade authority may initialize")]
    NotUpgradeAuthority,
    #[msg("Only the admin may update configuration")]
    NotAdmin,
    #[msg("ONCE mint has already been set")]
    OnceAlreadySet,
    #[msg("ONCE mint has not been set")]
    OnceNotSet,
    #[msg("Amounts and gate length must be positive")]
    InvalidValue,
    #[msg("Expiry must be in the future")]
    ExpiryNotFuture,
    #[msg("Call id must equal the next id")]
    IdMismatch,
    #[msg("Unsupported token program")]
    UnsupportedTokenProgram,
    #[msg("An active transfer hook is not supported")]
    TransferHookActive,
    #[msg("Transfer fee mints are not supported")]
    TransferFeeMint,
    #[msg("Default token account state must be initialized")]
    DefaultStateFrozen,
    #[msg("Vault deposit does not equal the requested amount")]
    DepositMismatch,
    #[msg("Call is not open")]
    NotOpen,
    #[msg("Call is not held")]
    NotHeld,
    #[msg("Call has already settled")]
    AlreadySettled,
    #[msg("Public purchase is unavailable during the priority interval")]
    InGate,
    #[msg("Priority interval has ended")]
    GateClosed,
    #[msg("Call has expired")]
    Expired,
    #[msg("Call has not expired")]
    NotExpired,
    #[msg("Signer is not the writer")]
    NotWriter,
    #[msg("Signer is not the holder")]
    NotHolder,
    #[msg("Signer is not the locker")]
    NotLocker,
    #[msg("Lock release slot has not arrived")]
    LockNotReleased,
    #[msg("Vault holds less than the call lot")]
    VaultShort,
    #[msg("Incorrect mint")]
    WrongMint,
    #[msg("Checked arithmetic overflow")]
    Overflow,
}
