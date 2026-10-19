use crate::{error::OnceError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

// Composite guards run before the enclosing account initializers.
#[derive(Accounts)]
pub struct WriteGuard<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct GateGuard<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"call", &call.id.to_le_bytes()], bump = call.bump,
        constraint = call.state == CallState::Open @ OnceError::NotOpen,
        constraint = Clock::get()?.unix_timestamp < call.expiry_ts @ OnceError::Expired,
        constraint = config.once_mint.is_some() @ OnceError::OnceNotSet,
        constraint = Clock::get()?.slot < call.gate_until @ OnceError::GateClosed)]
    pub call: Box<Account<'info, Call>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Init<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = deployment.programdata_address()? == Some(program_data.key()) @ OnceError::NotUpgradeAuthority)]
    pub deployment: Program<'info, crate::program::Once>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ OnceError::NotUpgradeAuthority)]
    pub program_data: Box<Account<'info, ProgramData>>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetOnce<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump,
        has_one = admin @ OnceError::NotAdmin,
        constraint = config.once_mint.is_none() @ OnceError::OnceAlreadySet)]
    pub config: Box<Account<'info, Config>>,
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ OnceError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Write<'info> {
    pub guard: WriteGuard<'info>,
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(init, payer = writer, space = new_call_space(&guard.config, id)?, seeds = [b"call".as_ref(), id.to_le_bytes().as_ref()], bump)]
    pub call: Box<Account<'info, Call>>,
    #[account(init, payer = writer, seeds = [b"vault", call.key().as_ref()], bump,
        token::mint = mint, token::authority = call, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = writer, token::token_program = token_program)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Buy<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"call", &call.id.to_le_bytes()], bump = call.bump,
        constraint = call.state == CallState::Open @ OnceError::NotOpen)]
    pub call: Box<Account<'info, Call>>,
    #[account(mut, seeds = [b"vault", call.key().as_ref()], bump,
        token::mint = mint, token::authority = call, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = call.mint @ OnceError::WrongMint,
        constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = call.token_program @ OnceError::UnsupportedTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = usdc_token_program,
        constraint = payment_destination.owner == call.writer @ OnceError::NotWriter)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct LockAndBuy<'info> {
    pub guard: GateGuard<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(init, payer = buyer, space = 8 + Lock::INIT_SPACE,
        seeds = [b"lock", guard.call.key().as_ref()], bump)]
    pub lock: Box<Account<'info, Lock>>,
    #[account(init, payer = buyer, seeds = [b"lock_vault", guard.call.key().as_ref()], bump,
        token::mint = once_mint, token::authority = lock, token::token_program = once_token_program)]
    pub lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = Some(once_mint.key()) == guard.config.once_mint @ OnceError::WrongMint,
        constraint = *once_mint.to_account_info().owner == once_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = Some(once_token_program.key()) == guard.config.once_token_program @ OnceError::UnsupportedTokenProgram)]
    pub once_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = once_mint, token::authority = buyer, token::token_program = once_token_program)]
    pub once_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", guard.call.key().as_ref()], bump,
        token::mint = mint, token::authority = guard.call, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = guard.call.mint @ OnceError::WrongMint,
        constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = guard.call.token_program @ OnceError::UnsupportedTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = guard.config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = usdc_token_program,
        constraint = payment_destination.owner == guard.call.writer @ OnceError::NotWriter)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Exercise<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"call", &call.id.to_le_bytes()], bump = call.bump,
        constraint = call.state == CallState::Held @ OnceError::NotHeld,
        constraint = call.holder == Some(holder.key()) @ OnceError::NotHolder)]
    pub call: Box<Account<'info, Call>>,
    #[account(mut, seeds = [b"vault", call.key().as_ref()], bump,
        token::mint = mint, token::authority = call, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = call.mint @ OnceError::WrongMint,
        constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = call.token_program @ OnceError::UnsupportedTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = holder, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = usdc_token_program,
        constraint = payment_destination.owner == call.writer @ OnceError::NotWriter)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = holder,
        associated_token::mint = mint, associated_token::authority = holder,
        associated_token::token_program = token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Receives only vault rent; address is bound to the writer.
    #[account(mut, address = call.writer @ OnceError::NotWriter)]
    pub writer: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(mut, seeds = [b"call", &call.id.to_le_bytes()], bump = call.bump, has_one = writer @ OnceError::NotWriter,
        constraint = call.state == CallState::Open @ OnceError::NotOpen)]
    pub call: Box<Account<'info, Call>>,
    #[account(mut, seeds = [b"vault", call.key().as_ref()], bump,
        token::mint = mint, token::authority = call, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = call.mint @ OnceError::WrongMint,
        constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = call.token_program @ OnceError::UnsupportedTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = mint, token::authority = writer, token::token_program = token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Reclaim<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(mut, seeds = [b"call", &call.id.to_le_bytes()], bump = call.bump, has_one = writer @ OnceError::NotWriter,
        constraint = matches!(call.state, CallState::Open | CallState::Held) @ OnceError::AlreadySettled)]
    pub call: Box<Account<'info, Call>>,
    #[account(mut, seeds = [b"vault", call.key().as_ref()], bump,
        token::mint = mint, token::authority = call, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = call.mint @ OnceError::WrongMint,
        constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = call.token_program @ OnceError::UnsupportedTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = mint, token::authority = writer, token::token_program = token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ReturnLock<'info> {
    #[account(mut)]
    pub locker: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"lock", lock.call.as_ref()], bump = lock.bump,
        has_one = locker @ OnceError::NotLocker, close = locker)]
    pub lock: Box<Account<'info, Lock>>,
    #[account(mut, seeds = [b"lock_vault", lock.call.as_ref()], bump,
        token::mint = once_mint, token::authority = lock, token::token_program = once_token_program)]
    pub lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = Some(once_mint.key()) == config.once_mint @ OnceError::WrongMint,
        constraint = *once_mint.to_account_info().owner == once_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = Some(once_token_program.key()) == config.once_token_program @ OnceError::UnsupportedTokenProgram)]
    pub once_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = once_mint, token::authority = locker, token::token_program = once_token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

// Anchor evaluates space before any create/allocate CPI, including prefunded PDAs.
fn new_call_space(config: &Config, id: u64) -> Result<usize> {
    require_eq!(config.next_id, id, OnceError::IdMismatch);
    Ok(8 + Call::INIT_SPACE)
}
