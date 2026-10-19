use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub once_mint: Option<Pubkey>,
    pub once_token_program: Option<Pubkey>,
    pub gate_slots: u64,
    pub lock_amount: u64,
    pub next_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Call {
    pub id: u64,
    pub writer: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub lot: u64,
    pub strike: u64,
    pub premium: u64,
    pub expiry_ts: i64,
    pub written_slot: u64,
    pub gate_until: u64,
    pub state: CallState,
    pub holder: Option<Pubkey>,
    pub bought_slot: u64,
    pub settled_slot: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CallState {
    Open,
    Held,
    Exercised,
    Reclaimed,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct Lock {
    pub locker: Pubkey,
    pub call: Pubkey,
    pub amount: u64,
    pub release_slot: u64,
    pub bump: u8,
}
