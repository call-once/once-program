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
        constraint = Clock::get()?.slot < gate_end(&call, &config) @ OnceError::GateClosed)]
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
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump,
        realloc = 8 + Config::INIT_SPACE, realloc::payer = admin, realloc::zero = false,
        has_one = admin @ OnceError::NotAdmin,
        constraint = config.once_mint.is_none() @ OnceError::OnceAlreadySet)]
    pub config: Box<Account<'info, Config>>,
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    pub system_program: Program<'info, System>,
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

#[event_cpi]
#[derive(Accounts)]
pub struct List<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(seeds = [b"call", &call.id.to_le_bytes()], bump = call.bump,
        constraint = call.state == CallState::Held @ OnceError::NotHeld,
        constraint = call.holder == Some(holder.key()) @ OnceError::NotHolder)]
    pub call: Box<Account<'info, Call>>,
    #[account(init_if_needed, payer = holder, space = 8 + Listing::INIT_SPACE,
        seeds = [b"listing", call.key().as_ref()], bump)]
    pub listing: Box<Account<'info, Listing>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Unlist<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, seeds = [b"listing", listing.call.as_ref()], bump = listing.bump,
        has_one = seller @ OnceError::NotSeller, close = seller)]
    pub listing: Box<Account<'info, Listing>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct BuyListed<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"call", &call.id.to_le_bytes()], bump = call.bump,
        constraint = call.state == CallState::Held @ OnceError::NotHeld)]
    pub call: Box<Account<'info, Call>>,
    #[account(mut, seeds = [b"listing", call.key().as_ref()], bump = listing.bump,
        constraint = call.holder == Some(listing.seller) @ OnceError::NotHolder, close = seller)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Receives only the listing rent; address is bound to the seller.
    #[account(mut, address = listing.seller @ OnceError::NotSeller)]
    pub seller: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = usdc_token_program,
        constraint = payment_destination.owner == listing.seller @ OnceError::NotSeller)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct LockAndBuyListed<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"call", &call.id.to_le_bytes()], bump = call.bump,
        constraint = call.state == CallState::Held @ OnceError::NotHeld)]
    pub call: Box<Account<'info, Call>>,
    #[account(mut, seeds = [b"listing", call.key().as_ref()], bump = listing.bump,
        constraint = call.holder == Some(listing.seller) @ OnceError::NotHolder, close = seller)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Receives only the listing rent; address is bound to the seller.
    #[account(mut, address = listing.seller @ OnceError::NotSeller)]
    pub seller: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = buyer, space = 8 + ResaleLock::INIT_SPACE,
        seeds = [b"resale_lock", call.key().as_ref(), buyer.key().as_ref()], bump)]
    pub lock: Box<Account<'info, ResaleLock>>,
    #[account(init_if_needed, payer = buyer, seeds = [b"resale_lock_vault", call.key().as_ref(), buyer.key().as_ref()], bump,
        token::mint = once_mint, token::authority = lock, token::token_program = once_token_program)]
    pub lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = Some(once_mint.key()) == config.once_mint @ OnceError::WrongMint,
        constraint = *once_mint.to_account_info().owner == once_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = Some(once_token_program.key()) == config.once_token_program @ OnceError::UnsupportedTokenProgram)]
    pub once_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = once_mint, token::authority = buyer, token::token_program = once_token_program)]
    pub once_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = usdc_token_program,
        constraint = payment_destination.owner == listing.seller @ OnceError::NotSeller)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ReturnResaleLock<'info> {
    #[account(mut)]
    pub locker: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"resale_lock", lock.call.as_ref(), locker.key().as_ref()], bump = lock.bump,
        has_one = locker @ OnceError::NotLocker, close = locker)]
    pub lock: Box<Account<'info, ResaleLock>>,
    #[account(mut, seeds = [b"resale_lock_vault", lock.call.as_ref(), locker.key().as_ref()], bump,
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

fn new_put_space(config: &Config, id: u64) -> Result<usize> {
    require_eq!(config.next_id, id, OnceError::IdMismatch);
    Ok(8 + Put::INIT_SPACE)
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct WritePut<'info> {
    pub guard: WriteGuard<'info>,
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(init, payer = writer, space = new_put_space(&guard.config, id)?, seeds = [b"put".as_ref(), id.to_le_bytes().as_ref()], bump)]
    pub put: Box<Account<'info, Put>>,
    #[account(init, payer = writer, seeds = [b"put_vault", put.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = put, token::token_program = usdc_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = guard.config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = writer, token::token_program = usdc_token_program)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PutGateGuard<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"put", &put.id.to_le_bytes()], bump = put.bump,
        constraint = put.state == CallState::Open @ OnceError::NotOpen,
        constraint = Clock::get()?.unix_timestamp < put.expiry_ts @ OnceError::Expired,
        constraint = config.once_mint.is_some() @ OnceError::OnceNotSet,
        constraint = Clock::get()?.slot < gate_end_put(&put, &config) @ OnceError::GateClosed)]
    pub put: Box<Account<'info, Put>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct BuyPut<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"put", &put.id.to_le_bytes()], bump = put.bump,
        constraint = put.state == CallState::Open @ OnceError::NotOpen)]
    pub put: Box<Account<'info, Put>>,
    #[account(seeds = [b"put_vault", put.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = put, token::token_program = usdc_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = usdc_token_program,
        constraint = payment_destination.owner == put.writer @ OnceError::NotWriter)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct LockAndBuyPut<'info> {
    pub guard: PutGateGuard<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(init, payer = buyer, space = 8 + Lock::INIT_SPACE,
        seeds = [b"lock", guard.put.key().as_ref()], bump)]
    pub lock: Box<Account<'info, Lock>>,
    #[account(init, payer = buyer, seeds = [b"lock_vault", guard.put.key().as_ref()], bump,
        token::mint = once_mint, token::authority = lock, token::token_program = once_token_program)]
    pub lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = Some(once_mint.key()) == guard.config.once_mint @ OnceError::WrongMint,
        constraint = *once_mint.to_account_info().owner == once_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = Some(once_token_program.key()) == guard.config.once_token_program @ OnceError::UnsupportedTokenProgram)]
    pub once_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = once_mint, token::authority = buyer, token::token_program = once_token_program)]
    pub once_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(seeds = [b"put_vault", guard.put.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = guard.put, token::token_program = usdc_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = guard.config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = usdc_token_program,
        constraint = payment_destination.owner == guard.put.writer @ OnceError::NotWriter)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ExercisePut<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, seeds = [b"put", &put.id.to_le_bytes()], bump = put.bump,
        constraint = put.state == CallState::Held @ OnceError::NotHeld,
        constraint = put.holder == Some(holder.key()) @ OnceError::NotHolder)]
    pub put: Box<Account<'info, Put>>,
    #[account(mut, seeds = [b"put_vault", put.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = put, token::token_program = usdc_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = put.mint @ OnceError::WrongMint,
        constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = put.token_program @ OnceError::UnsupportedTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = mint, token::authority = holder, token::token_program = token_program)]
    pub stock_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = writer, token::token_program = token_program)]
    pub stock_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = holder, token::token_program = usdc_token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Owns the stock destination and receives only vault rent; address is bound to the writer.
    #[account(mut, address = put.writer @ OnceError::NotWriter)]
    pub writer: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CancelPut<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(mut, seeds = [b"put", &put.id.to_le_bytes()], bump = put.bump, has_one = writer @ OnceError::NotWriter,
        constraint = put.state == CallState::Open @ OnceError::NotOpen)]
    pub put: Box<Account<'info, Put>>,
    #[account(mut, seeds = [b"put_vault", put.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = put, token::token_program = usdc_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = writer, token::token_program = usdc_token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ReclaimPut<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(mut, seeds = [b"put", &put.id.to_le_bytes()], bump = put.bump, has_one = writer @ OnceError::NotWriter,
        constraint = matches!(put.state, CallState::Open | CallState::Held) @ OnceError::AlreadySettled)]
    pub put: Box<Account<'info, Put>>,
    #[account(mut, seeds = [b"put_vault", put.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = put, token::token_program = usdc_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = writer, token::token_program = usdc_token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ListPut<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(seeds = [b"put", &put.id.to_le_bytes()], bump = put.bump,
        constraint = put.state == CallState::Held @ OnceError::NotHeld,
        constraint = put.holder == Some(holder.key()) @ OnceError::NotHolder)]
    pub put: Box<Account<'info, Put>>,
    #[account(init_if_needed, payer = holder, space = 8 + Listing::INIT_SPACE,
        seeds = [b"listing", put.key().as_ref()], bump)]
    pub listing: Box<Account<'info, Listing>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct BuyListedPut<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"put", &put.id.to_le_bytes()], bump = put.bump,
        constraint = put.state == CallState::Held @ OnceError::NotHeld)]
    pub put: Box<Account<'info, Put>>,
    #[account(mut, seeds = [b"listing", put.key().as_ref()], bump = listing.bump,
        constraint = put.holder == Some(listing.seller) @ OnceError::NotHolder, close = seller)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Receives only the listing rent; address is bound to the seller.
    #[account(mut, address = listing.seller @ OnceError::NotSeller)]
    pub seller: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = usdc_token_program,
        constraint = payment_destination.owner == listing.seller @ OnceError::NotSeller)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct LockAndBuyListedPut<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"put", &put.id.to_le_bytes()], bump = put.bump,
        constraint = put.state == CallState::Held @ OnceError::NotHeld)]
    pub put: Box<Account<'info, Put>>,
    #[account(mut, seeds = [b"listing", put.key().as_ref()], bump = listing.bump,
        constraint = put.holder == Some(listing.seller) @ OnceError::NotHolder, close = seller)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Receives only the listing rent; address is bound to the seller.
    #[account(mut, address = listing.seller @ OnceError::NotSeller)]
    pub seller: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = buyer, space = 8 + ResaleLock::INIT_SPACE,
        seeds = [b"resale_lock", put.key().as_ref(), buyer.key().as_ref()], bump)]
    pub lock: Box<Account<'info, ResaleLock>>,
    #[account(init_if_needed, payer = buyer, seeds = [b"resale_lock_vault", put.key().as_ref(), buyer.key().as_ref()], bump,
        token::mint = once_mint, token::authority = lock, token::token_program = once_token_program)]
    pub lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = Some(once_mint.key()) == config.once_mint @ OnceError::WrongMint,
        constraint = *once_mint.to_account_info().owner == once_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = Some(once_token_program.key()) == config.once_token_program @ OnceError::UnsupportedTokenProgram)]
    pub once_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = once_mint, token::authority = buyer, token::token_program = once_token_program)]
    pub once_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::token_program = usdc_token_program,
        constraint = payment_destination.owner == listing.seller @ OnceError::NotSeller)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CloseOut<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(mut, seeds = [b"call", &call.id.to_le_bytes()], bump = call.bump, has_one = writer @ OnceError::NotWriter,
        constraint = call.state == CallState::Held @ OnceError::NotHeld,
        constraint = call.holder == Some(writer.key()) @ OnceError::NotHolder)]
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
pub struct CloseOutPut<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(mut, seeds = [b"put", &put.id.to_le_bytes()], bump = put.bump, has_one = writer @ OnceError::NotWriter,
        constraint = put.state == CallState::Held @ OnceError::NotHeld,
        constraint = put.holder == Some(writer.key()) @ OnceError::NotHolder)]
    pub put: Box<Account<'info, Put>>,
    #[account(mut, seeds = [b"put_vault", put.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = put, token::token_program = usdc_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = writer, token::token_program = usdc_token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

// Placing an order locks ONCE, so ONCE must be set.
fn new_order_space(config: &Config) -> Result<usize> {
    require!(config.once_mint.is_some(), OnceError::OnceNotSet);
    Ok(8 + Order::INIT_SPACE)
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = buyer, space = new_order_space(&config)?,
        seeds = [b"order".as_ref(), buyer.key().as_ref(), nonce.to_le_bytes().as_ref()], bump)]
    pub order: Box<Account<'info, Order>>,
    #[account(init, payer = buyer, seeds = [b"order_vault", order.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = order, token::token_program = usdc_token_program)]
    pub order_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = buyer, seeds = [b"order_once", order.key().as_ref()], bump,
        token::mint = once_mint, token::authority = order, token::token_program = once_token_program)]
    pub order_once: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(constraint = Some(once_mint.key()) == config.once_mint @ OnceError::WrongMint,
        constraint = *once_mint.to_account_info().owner == once_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = Some(once_token_program.key()) == config.once_token_program @ OnceError::UnsupportedTokenProgram)]
    pub once_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = once_mint, token::authority = buyer, token::token_program = once_token_program)]
    pub once_source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_source: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"order", order.buyer.as_ref(), &order.nonce.to_le_bytes()], bump = order.bump,
        has_one = buyer @ OnceError::NotBuyer, close = buyer)]
    pub order: Box<Account<'info, Order>>,
    #[account(mut, seeds = [b"order_vault", order.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = order, token::token_program = usdc_token_program)]
    pub order_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"order_once", order.key().as_ref()], bump,
        token::mint = once_mint, token::authority = order, token::token_program = once_token_program)]
    pub order_once: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = Some(once_mint.key()) == config.once_mint @ OnceError::WrongMint,
        constraint = *once_mint.to_account_info().owner == once_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = Some(once_token_program.key()) == config.once_token_program @ OnceError::UnsupportedTokenProgram)]
    pub once_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = once_mint, token::authority = buyer, token::token_program = once_token_program)]
    pub once_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer, token::token_program = usdc_token_program)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct FillOrder<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"order", order.buyer.as_ref(), &order.nonce.to_le_bytes()], bump = order.bump,
        constraint = order.kind == OptionKind::Call @ OnceError::WrongKind, close = buyer)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: Receives only the order's rent; address is bound to the order's buyer.
    #[account(mut, address = order.buyer @ OnceError::NotBuyer)]
    pub buyer: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"order_vault", order.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = order, token::token_program = usdc_token_program)]
    pub order_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"order_once", order.key().as_ref()], bump,
        token::mint = once_mint, token::authority = order, token::token_program = once_token_program)]
    pub order_once: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = writer, space = new_call_space(&config, id)?, seeds = [b"call".as_ref(), id.to_le_bytes().as_ref()], bump)]
    pub call: Box<Account<'info, Call>>,
    #[account(init, payer = writer, seeds = [b"vault", call.key().as_ref()], bump,
        token::mint = mint, token::authority = call, token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = writer, space = 8 + Lock::INIT_SPACE, seeds = [b"lock", call.key().as_ref()], bump)]
    pub option_lock: Box<Account<'info, Lock>>,
    #[account(init, payer = writer, seeds = [b"lock_vault", call.key().as_ref()], bump,
        token::mint = once_mint, token::authority = option_lock, token::token_program = once_token_program)]
    pub option_lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = order.mint @ OnceError::WrongMint,
        constraint = *mint.to_account_info().owner == token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = order.token_program @ OnceError::UnsupportedTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = mint, token::authority = writer, token::token_program = token_program)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = writer, token::token_program = usdc_token_program)]
    pub payment_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = Some(once_mint.key()) == config.once_mint @ OnceError::WrongMint,
        constraint = *once_mint.to_account_info().owner == once_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = Some(once_token_program.key()) == config.once_token_program @ OnceError::UnsupportedTokenProgram)]
    pub once_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct FillPutOrder<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"order", order.buyer.as_ref(), &order.nonce.to_le_bytes()], bump = order.bump,
        constraint = order.kind == OptionKind::Put @ OnceError::WrongKind, close = buyer)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: Receives only the order's rent; address is bound to the order's buyer.
    #[account(mut, address = order.buyer @ OnceError::NotBuyer)]
    pub buyer: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"order_vault", order.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = order, token::token_program = usdc_token_program)]
    pub order_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"order_once", order.key().as_ref()], bump,
        token::mint = once_mint, token::authority = order, token::token_program = once_token_program)]
    pub order_once: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = writer, space = new_put_space(&config, id)?, seeds = [b"put".as_ref(), id.to_le_bytes().as_ref()], bump)]
    pub put: Box<Account<'info, Put>>,
    #[account(init, payer = writer, seeds = [b"put_vault", put.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = put, token::token_program = usdc_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = writer, space = 8 + Lock::INIT_SPACE, seeds = [b"lock", put.key().as_ref()], bump)]
    pub option_lock: Box<Account<'info, Lock>>,
    #[account(init, payer = writer, seeds = [b"lock_vault", put.key().as_ref()], bump,
        token::mint = once_mint, token::authority = option_lock, token::token_program = once_token_program)]
    pub option_lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = order.mint @ OnceError::WrongMint,
        constraint = *mint.to_account_info().owner == order.token_program @ OnceError::UnsupportedTokenProgram)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.usdc_mint @ OnceError::WrongMint,
        constraint = *usdc_mint.to_account_info().owner == usdc_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = usdc_mint, token::authority = writer, token::token_program = usdc_token_program)]
    pub usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = Some(once_mint.key()) == config.once_mint @ OnceError::WrongMint,
        constraint = *once_mint.to_account_info().owner == once_token_program.key() @ OnceError::UnsupportedTokenProgram)]
    pub once_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = Some(once_token_program.key()) == config.once_token_program @ OnceError::UnsupportedTokenProgram)]
    pub once_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
