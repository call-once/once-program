use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, CloseAccount, TransferChecked};

pub mod contexts;
pub mod error;
pub mod events;
pub mod mint;
pub mod state;

use contexts::*;
use error::OnceError;
use events::*;
use state::*;

declare_id!("GRzKU9i3Cs7A5Euf9gGZjbRnpypw7DzaU3hWRfUgpYTa");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "once",
    project_url: "https://callonce.xyz",
    contacts: "link:https://x.com/calloncedotxyz",
    policy: "https://github.com/call-once/once-program/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/call-once/once-program"
}


#[program]
pub mod once {
    use super::*;

    pub fn init(
        ctx: Context<Init>,
        admin: Pubkey,
        gate_slots: u64,
        lock_amount: u64,
    ) -> Result<()> {
        require!(gate_slots > 0 && lock_amount > 0, OnceError::InvalidValue);
        ctx.accounts.config.set_inner(Config {
            admin,
            usdc_mint: ctx.accounts.usdc_mint.key(),
            once_mint: None,
            once_token_program: None,
            gate_slots,
            lock_amount,
            next_id: 0,
            bump: ctx.bumps.config,
            gate_floor: 0,
        });
        emit_cpi!(Initialized {
            admin,
            usdc_mint: ctx.accounts.usdc_mint.key(),
            gate_slots,
            lock_amount
        });
        Ok(())
    }

    pub fn set_once(ctx: Context<SetOnce>) -> Result<()> {
        let mint = ctx.accounts.once_mint.key();
        let owner = *ctx.accounts.once_mint.to_account_info().owner;
        ctx.accounts.config.gate_floor = Clock::get()?
            .slot
            .checked_add(ctx.accounts.config.gate_slots)
            .ok_or(OnceError::Overflow)?;
        ctx.accounts.config.once_mint = Some(mint);
        ctx.accounts.config.once_token_program = Some(owner);
        emit_cpi!(OnceSet {
            once_mint: mint,
            once_token_program: owner
        });
        Ok(())
    }

    pub fn set_params(ctx: Context<SetParams>, gate_slots: u64, lock_amount: u64) -> Result<()> {
        require!(gate_slots > 0 && lock_amount > 0, OnceError::InvalidValue);
        ctx.accounts.config.gate_slots = gate_slots;
        ctx.accounts.config.lock_amount = lock_amount;
        emit_cpi!(ParamsSet {
            gate_slots,
            lock_amount
        });
        Ok(())
    }

    pub fn write(
        ctx: Context<Write>,
        id: u64,
        lot: u64,
        strike: u64,
        premium: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        require!(
            lot > 0 && strike > 0 && premium > 0,
            OnceError::InvalidValue
        );
        let clock = Clock::get()?;
        require!(expiry_ts > clock.unix_timestamp, OnceError::ExpiryNotFuture);
        mint::validate_mint(&ctx.accounts.mint.to_account_info())?;
        let config = &mut ctx.accounts.guard.config;
        let gate_until = if config.once_mint.is_some() {
            clock
                .slot
                .checked_add(config.gate_slots)
                .ok_or(OnceError::Overflow)?
        } else {
            clock.slot
        };
        let next_id = config.next_id.checked_add(1).ok_or(OnceError::Overflow)?;
        transfer(
            ctx.accounts.token_program.key(),
            ctx.accounts.source.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            lot,
            ctx.accounts.mint.decimals,
            &[],
        )?;
        ctx.accounts.vault.reload()?;
        require_eq!(ctx.accounts.vault.amount, lot, OnceError::DepositMismatch);
        ctx.accounts.call.set_inner(Call {
            id,
            writer: ctx.accounts.writer.key(),
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            lot,
            strike,
            premium,
            expiry_ts,
            written_slot: clock.slot,
            gate_until,
            state: CallState::Open,
            holder: None,
            bought_slot: 0,
            settled_slot: 0,
            bump: ctx.bumps.call,
        });
        config.next_id = next_id;
        emit_cpi!(Written {
            call: ctx.accounts.call.key(),
            id,
            writer: ctx.accounts.writer.key(),
            mint: ctx.accounts.mint.key(),
            lot,
            strike,
            premium,
            expiry_ts,
            written_slot: clock.slot,
            gate_until
        });
        Ok(())
    }

    pub fn buy(ctx: Context<Buy>) -> Result<()> {
        let clock = Clock::get()?;
        let call = &mut ctx.accounts.call;
        require!(clock.unix_timestamp < call.expiry_ts, OnceError::Expired);
        require!(ctx.accounts.config.once_mint.is_some(), OnceError::OnceNotSet);
        require!(clock.slot >= gate_end(call, &ctx.accounts.config), OnceError::InGate);
        require!(ctx.accounts.vault.amount >= call.lot, OnceError::VaultShort);
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.payment_source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.payment_destination.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            call.premium,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        call.holder = Some(ctx.accounts.buyer.key());
        call.bought_slot = clock.slot;
        call.state = CallState::Held;
        emit_cpi!(Bought {
            call: call.key(),
            id: call.id,
            holder: ctx.accounts.buyer.key(),
            premium: call.premium,
            slot: clock.slot,
            locked: 0
        });
        Ok(())
    }

    pub fn lock_and_buy(ctx: Context<LockAndBuy>) -> Result<()> {
        let clock = Clock::get()?;
        let call = &mut ctx.accounts.guard.call;
        let amount = ctx.accounts.guard.config.lock_amount;
        require!(ctx.accounts.vault.amount >= call.lot, OnceError::VaultShort);
        transfer(
            ctx.accounts.once_token_program.key(),
            ctx.accounts.once_source.to_account_info(),
            ctx.accounts.once_mint.to_account_info(),
            ctx.accounts.lock_vault.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            amount,
            ctx.accounts.once_mint.decimals,
            &[],
        )?;
        ctx.accounts.lock_vault.reload()?;
        require_eq!(
            ctx.accounts.lock_vault.amount,
            amount,
            OnceError::DepositMismatch
        );
        ctx.accounts.lock.set_inner(Lock {
            locker: ctx.accounts.buyer.key(),
            call: call.key(),
            amount,
            release_slot: gate_end(call, &ctx.accounts.guard.config),
            bump: ctx.bumps.lock,
        });
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.payment_source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.payment_destination.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            call.premium,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        call.holder = Some(ctx.accounts.buyer.key());
        call.bought_slot = clock.slot;
        call.state = CallState::Held;
        emit_cpi!(Bought {
            call: call.key(),
            id: call.id,
            holder: ctx.accounts.buyer.key(),
            premium: call.premium,
            slot: clock.slot,
            locked: amount
        });
        Ok(())
    }

    pub fn call(ctx: Context<Exercise>) -> Result<()> {
        let clock = Clock::get()?;
        let call = &mut ctx.accounts.call;
        require!(clock.unix_timestamp < call.expiry_ts, OnceError::Expired);
        require!(ctx.accounts.vault.amount >= call.lot, OnceError::VaultShort);
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.payment_source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.payment_destination.to_account_info(),
            ctx.accounts.holder.to_account_info(),
            call.strike,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        let id = call.id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"call", &id, &[call.bump]];
        let delivered = ctx.accounts.vault.amount;
        transfer(
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            call.to_account_info(),
            delivered,
            ctx.accounts.mint.decimals,
            &[seeds],
        )?;
        close(
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            call.to_account_info(),
            &[seeds],
        )?;
        call.state = CallState::Exercised;
        call.settled_slot = clock.slot;
        emit_cpi!(Exercised {
            call: call.key(),
            id: call.id,
            holder: ctx.accounts.holder.key(),
            writer: call.writer,
            strike: call.strike,
            delivered,
            slot: clock.slot
        });
        Ok(())
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let call = &mut ctx.accounts.call;
        let returned = ctx.accounts.vault.amount;
        settle(
            call,
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            returned,
            ctx.accounts.mint.decimals,
        )?;
        call.state = CallState::Cancelled;
        call.settled_slot = Clock::get()?.slot;
        emit_cpi!(Cancelled {
            call: call.key(),
            id: call.id,
            writer: call.writer,
            returned,
            slot: call.settled_slot
        });
        Ok(())
    }

    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        let clock = Clock::get()?;
        let call = &mut ctx.accounts.call;
        require!(
            clock.unix_timestamp >= call.expiry_ts,
            OnceError::NotExpired
        );
        let returned = ctx.accounts.vault.amount;
        settle(
            call,
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            returned,
            ctx.accounts.mint.decimals,
        )?;
        call.state = CallState::Reclaimed;
        call.settled_slot = clock.slot;
        emit_cpi!(Reclaimed {
            call: call.key(),
            id: call.id,
            writer: call.writer,
            holder: call.holder,
            returned,
            slot: clock.slot
        });
        Ok(())
    }

    pub fn return_lock(ctx: Context<ReturnLock>) -> Result<()> {
        let clock = Clock::get()?;
        let lock = &ctx.accounts.lock;
        require!(clock.slot >= lock.release_slot, OnceError::LockNotReleased);
        let returned = ctx.accounts.lock_vault.amount;
        let seeds: &[&[u8]] = &[b"lock", lock.call.as_ref(), &[lock.bump]];
        transfer(
            ctx.accounts.once_token_program.key(),
            ctx.accounts.lock_vault.to_account_info(),
            ctx.accounts.once_mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            lock.to_account_info(),
            returned,
            ctx.accounts.once_mint.decimals,
            &[seeds],
        )?;
        close(
            ctx.accounts.once_token_program.key(),
            ctx.accounts.lock_vault.to_account_info(),
            ctx.accounts.locker.to_account_info(),
            lock.to_account_info(),
            &[seeds],
        )?;
        emit_cpi!(LockReturned {
            call: lock.call,
            locker: lock.locker,
            returned,
            slot: clock.slot
        });
        Ok(())
    }

    pub fn list(ctx: Context<List>, price: u64) -> Result<()> {
        require!(price > 0, OnceError::InvalidValue);
        let clock = Clock::get()?;
        let call = &ctx.accounts.call;
        require!(clock.unix_timestamp < call.expiry_ts, OnceError::Expired);
        let holder = ctx.accounts.holder.key();
        let listing = &mut ctx.accounts.listing;
        require!(
            listing.seller == Pubkey::default() || listing.seller == holder,
            OnceError::NotSeller
        );
        listing.set_inner(Listing {
            call: call.key(),
            seller: holder,
            price,
            listed_slot: clock.slot,
            bump: ctx.bumps.listing,
        });
        emit_cpi!(Listed {
            call: call.key(),
            id: call.id,
            seller: holder,
            price,
            slot: clock.slot
        });
        Ok(())
    }

    pub fn unlist(ctx: Context<Unlist>) -> Result<()> {
        emit_cpi!(Unlisted {
            call: ctx.accounts.listing.call,
            seller: ctx.accounts.seller.key(),
            slot: Clock::get()?.slot
        });
        Ok(())
    }

    pub fn buy_listed(ctx: Context<BuyListed>, price: u64) -> Result<()> {
        let clock = Clock::get()?;
        let call = &mut ctx.accounts.call;
        require!(clock.unix_timestamp < call.expiry_ts, OnceError::Expired);
        require!(clock.slot >= gate_end(call, &ctx.accounts.config), OnceError::InGate);
        require_eq!(ctx.accounts.listing.price, price, OnceError::PriceChanged);
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.payment_source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.payment_destination.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            price,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        let seller = ctx.accounts.listing.seller;
        call.holder = Some(ctx.accounts.buyer.key());
        call.bought_slot = clock.slot;
        emit_cpi!(Resold {
            call: call.key(),
            id: call.id,
            seller,
            buyer: ctx.accounts.buyer.key(),
            price,
            slot: clock.slot,
            locked: 0
        });
        Ok(())
    }

    pub fn lock_and_buy_listed(ctx: Context<LockAndBuyListed>, price: u64) -> Result<()> {
        let clock = Clock::get()?;
        let config = &ctx.accounts.config;
        let call = &mut ctx.accounts.call;
        require!(clock.unix_timestamp < call.expiry_ts, OnceError::Expired);
        require!(config.once_mint.is_some(), OnceError::OnceNotSet);
        let end = gate_end(call, config);
        require!(clock.slot < end, OnceError::GateClosed);
        require_eq!(ctx.accounts.listing.price, price, OnceError::PriceChanged);
        let amount = config.lock_amount;
        // A wallet that buys the same call again inside the gate adds a fresh lock_amount to its resale lock.
        let held = ctx.accounts.lock_vault.amount;
        let total = held.checked_add(amount).ok_or(OnceError::Overflow)?;
        transfer(
            ctx.accounts.once_token_program.key(),
            ctx.accounts.once_source.to_account_info(),
            ctx.accounts.once_mint.to_account_info(),
            ctx.accounts.lock_vault.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            amount,
            ctx.accounts.once_mint.decimals,
            &[],
        )?;
        ctx.accounts.lock_vault.reload()?;
        require_eq!(ctx.accounts.lock_vault.amount, total, OnceError::DepositMismatch);
        let lock = &mut ctx.accounts.lock;
        if lock.locker == Pubkey::default() {
            lock.set_inner(ResaleLock {
                locker: ctx.accounts.buyer.key(),
                call: call.key(),
                amount,
                release_slot: end,
                bump: ctx.bumps.lock,
            });
        } else {
            require_keys_eq!(lock.locker, ctx.accounts.buyer.key(), OnceError::NotLocker);
            require_eq!(lock.release_slot, end, OnceError::InvalidValue);
            lock.amount = lock.amount.checked_add(amount).ok_or(OnceError::Overflow)?;
        }
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.payment_source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.payment_destination.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            price,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        let seller = ctx.accounts.listing.seller;
        call.holder = Some(ctx.accounts.buyer.key());
        call.bought_slot = clock.slot;
        emit_cpi!(Resold {
            call: call.key(),
            id: call.id,
            seller,
            buyer: ctx.accounts.buyer.key(),
            price,
            slot: clock.slot,
            locked: amount
        });
        Ok(())
    }

    pub fn return_resale_lock(ctx: Context<ReturnResaleLock>) -> Result<()> {
        let clock = Clock::get()?;
        let lock = &ctx.accounts.lock;
        require!(clock.slot >= lock.release_slot, OnceError::LockNotReleased);
        let returned = ctx.accounts.lock_vault.amount;
        let seeds: &[&[u8]] = &[b"resale_lock", lock.call.as_ref(), lock.locker.as_ref(), &[lock.bump]];
        transfer(
            ctx.accounts.once_token_program.key(),
            ctx.accounts.lock_vault.to_account_info(),
            ctx.accounts.once_mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            lock.to_account_info(),
            returned,
            ctx.accounts.once_mint.decimals,
            &[seeds],
        )?;
        close(
            ctx.accounts.once_token_program.key(),
            ctx.accounts.lock_vault.to_account_info(),
            ctx.accounts.locker.to_account_info(),
            lock.to_account_info(),
            &[seeds],
        )?;
        emit_cpi!(ResaleLockReturned {
            call: lock.call,
            locker: lock.locker,
            returned,
            slot: clock.slot
        });
        Ok(())
    }

    pub fn write_put(
        ctx: Context<WritePut>,
        id: u64,
        lot: u64,
        strike: u64,
        premium: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        require!(
            lot > 0 && strike > 0 && premium > 0,
            OnceError::InvalidValue
        );
        let clock = Clock::get()?;
        require!(expiry_ts > clock.unix_timestamp, OnceError::ExpiryNotFuture);
        mint::validate_put_mint(&ctx.accounts.mint.to_account_info())?;
        let config = &mut ctx.accounts.guard.config;
        let gate_until = if config.once_mint.is_some() {
            clock
                .slot
                .checked_add(config.gate_slots)
                .ok_or(OnceError::Overflow)?
        } else {
            clock.slot
        };
        let next_id = config.next_id.checked_add(1).ok_or(OnceError::Overflow)?;
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            strike,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        ctx.accounts.vault.reload()?;
        require_eq!(ctx.accounts.vault.amount, strike, OnceError::DepositMismatch);
        ctx.accounts.put.set_inner(Put {
            id,
            writer: ctx.accounts.writer.key(),
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            lot,
            strike,
            premium,
            expiry_ts,
            written_slot: clock.slot,
            gate_until,
            state: CallState::Open,
            holder: None,
            bought_slot: 0,
            settled_slot: 0,
            bump: ctx.bumps.put,
        });
        config.next_id = next_id;
        emit_cpi!(PutWritten {
            put: ctx.accounts.put.key(),
            id,
            writer: ctx.accounts.writer.key(),
            mint: ctx.accounts.mint.key(),
            lot,
            strike,
            premium,
            expiry_ts,
            written_slot: clock.slot,
            gate_until
        });
        Ok(())
    }

    pub fn buy_put(ctx: Context<BuyPut>) -> Result<()> {
        let clock = Clock::get()?;
        let put = &mut ctx.accounts.put;
        require!(clock.unix_timestamp < put.expiry_ts, OnceError::Expired);
        require!(ctx.accounts.config.once_mint.is_some(), OnceError::OnceNotSet);
        require!(clock.slot >= gate_end_put(put, &ctx.accounts.config), OnceError::InGate);
        require!(ctx.accounts.vault.amount >= put.strike, OnceError::VaultShort);
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.payment_source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.payment_destination.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            put.premium,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        put.holder = Some(ctx.accounts.buyer.key());
        put.bought_slot = clock.slot;
        put.state = CallState::Held;
        emit_cpi!(PutBought {
            put: put.key(),
            id: put.id,
            holder: ctx.accounts.buyer.key(),
            premium: put.premium,
            slot: clock.slot,
            locked: 0
        });
        Ok(())
    }

    pub fn lock_and_buy_put(ctx: Context<LockAndBuyPut>) -> Result<()> {
        let clock = Clock::get()?;
        let put = &mut ctx.accounts.guard.put;
        let amount = ctx.accounts.guard.config.lock_amount;
        require!(ctx.accounts.vault.amount >= put.strike, OnceError::VaultShort);
        transfer(
            ctx.accounts.once_token_program.key(),
            ctx.accounts.once_source.to_account_info(),
            ctx.accounts.once_mint.to_account_info(),
            ctx.accounts.lock_vault.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            amount,
            ctx.accounts.once_mint.decimals,
            &[],
        )?;
        ctx.accounts.lock_vault.reload()?;
        require_eq!(ctx.accounts.lock_vault.amount, amount, OnceError::DepositMismatch);
        ctx.accounts.lock.set_inner(Lock {
            locker: ctx.accounts.buyer.key(),
            call: put.key(),
            amount,
            release_slot: gate_end_put(put, &ctx.accounts.guard.config),
            bump: ctx.bumps.lock,
        });
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.payment_source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.payment_destination.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            put.premium,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        put.holder = Some(ctx.accounts.buyer.key());
        put.bought_slot = clock.slot;
        put.state = CallState::Held;
        emit_cpi!(PutBought {
            put: put.key(),
            id: put.id,
            holder: ctx.accounts.buyer.key(),
            premium: put.premium,
            slot: clock.slot,
            locked: amount
        });
        Ok(())
    }

    pub fn exercise_put(ctx: Context<ExercisePut>) -> Result<()> {
        let clock = Clock::get()?;
        let put = &mut ctx.accounts.put;
        require!(clock.unix_timestamp < put.expiry_ts, OnceError::Expired);
        require!(ctx.accounts.vault.amount >= put.strike, OnceError::VaultShort);
        let before = ctx.accounts.stock_destination.amount;
        transfer(
            ctx.accounts.token_program.key(),
            ctx.accounts.stock_source.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.stock_destination.to_account_info(),
            ctx.accounts.holder.to_account_info(),
            put.lot,
            ctx.accounts.mint.decimals,
            &[],
        )?;
        ctx.accounts.stock_destination.reload()?;
        require_eq!(
            ctx.accounts.stock_destination.amount,
            before.checked_add(put.lot).ok_or(OnceError::Overflow)?,
            OnceError::DepositMismatch
        );
        let id = put.id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"put", &id, &[put.bump]];
        let paid = ctx.accounts.vault.amount;
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            put.to_account_info(),
            paid,
            ctx.accounts.usdc_mint.decimals,
            &[seeds],
        )?;
        close(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            put.to_account_info(),
            &[seeds],
        )?;
        put.state = CallState::Exercised;
        put.settled_slot = clock.slot;
        emit_cpi!(PutExercised {
            put: put.key(),
            id: put.id,
            holder: ctx.accounts.holder.key(),
            writer: put.writer,
            delivered: put.lot,
            paid,
            slot: clock.slot
        });
        Ok(())
    }

    pub fn cancel_put(ctx: Context<CancelPut>) -> Result<()> {
        let put = &mut ctx.accounts.put;
        let returned = ctx.accounts.vault.amount;
        settle_put(
            put,
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            returned,
            ctx.accounts.usdc_mint.decimals,
        )?;
        put.state = CallState::Cancelled;
        put.settled_slot = Clock::get()?.slot;
        emit_cpi!(PutCancelled {
            put: put.key(),
            id: put.id,
            writer: put.writer,
            returned,
            slot: put.settled_slot
        });
        Ok(())
    }

    pub fn reclaim_put(ctx: Context<ReclaimPut>) -> Result<()> {
        let clock = Clock::get()?;
        let put = &mut ctx.accounts.put;
        require!(clock.unix_timestamp >= put.expiry_ts, OnceError::NotExpired);
        let returned = ctx.accounts.vault.amount;
        settle_put(
            put,
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            returned,
            ctx.accounts.usdc_mint.decimals,
        )?;
        put.state = CallState::Reclaimed;
        put.settled_slot = clock.slot;
        emit_cpi!(PutReclaimed {
            put: put.key(),
            id: put.id,
            writer: put.writer,
            holder: put.holder,
            returned,
            slot: clock.slot
        });
        Ok(())
    }

    pub fn list_put(ctx: Context<ListPut>, price: u64) -> Result<()> {
        require!(price > 0, OnceError::InvalidValue);
        let clock = Clock::get()?;
        let put = &ctx.accounts.put;
        require!(clock.unix_timestamp < put.expiry_ts, OnceError::Expired);
        let holder = ctx.accounts.holder.key();
        let listing = &mut ctx.accounts.listing;
        require!(
            listing.seller == Pubkey::default() || listing.seller == holder,
            OnceError::NotSeller
        );
        listing.set_inner(Listing {
            call: put.key(),
            seller: holder,
            price,
            listed_slot: clock.slot,
            bump: ctx.bumps.listing,
        });
        emit_cpi!(PutListed {
            put: put.key(),
            id: put.id,
            seller: holder,
            price,
            slot: clock.slot
        });
        Ok(())
    }

    pub fn buy_listed_put(ctx: Context<BuyListedPut>, price: u64) -> Result<()> {
        let clock = Clock::get()?;
        let put = &mut ctx.accounts.put;
        require!(clock.unix_timestamp < put.expiry_ts, OnceError::Expired);
        require!(clock.slot >= gate_end_put(put, &ctx.accounts.config), OnceError::InGate);
        require_eq!(ctx.accounts.listing.price, price, OnceError::PriceChanged);
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.payment_source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.payment_destination.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            price,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        let seller = ctx.accounts.listing.seller;
        put.holder = Some(ctx.accounts.buyer.key());
        put.bought_slot = clock.slot;
        emit_cpi!(PutResold {
            put: put.key(),
            id: put.id,
            seller,
            buyer: ctx.accounts.buyer.key(),
            price,
            slot: clock.slot,
            locked: 0
        });
        Ok(())
    }

    pub fn lock_and_buy_listed_put(ctx: Context<LockAndBuyListedPut>, price: u64) -> Result<()> {
        let clock = Clock::get()?;
        let config = &ctx.accounts.config;
        let put = &mut ctx.accounts.put;
        require!(clock.unix_timestamp < put.expiry_ts, OnceError::Expired);
        require!(config.once_mint.is_some(), OnceError::OnceNotSet);
        let end = gate_end_put(put, config);
        require!(clock.slot < end, OnceError::GateClosed);
        require_eq!(ctx.accounts.listing.price, price, OnceError::PriceChanged);
        let amount = config.lock_amount;
        // As for a call: a wallet that buys the same put again inside the gate adds a fresh lock_amount to its resale lock.
        let held = ctx.accounts.lock_vault.amount;
        let total = held.checked_add(amount).ok_or(OnceError::Overflow)?;
        transfer(
            ctx.accounts.once_token_program.key(),
            ctx.accounts.once_source.to_account_info(),
            ctx.accounts.once_mint.to_account_info(),
            ctx.accounts.lock_vault.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            amount,
            ctx.accounts.once_mint.decimals,
            &[],
        )?;
        ctx.accounts.lock_vault.reload()?;
        require_eq!(ctx.accounts.lock_vault.amount, total, OnceError::DepositMismatch);
        let lock = &mut ctx.accounts.lock;
        if lock.locker == Pubkey::default() {
            lock.set_inner(ResaleLock {
                locker: ctx.accounts.buyer.key(),
                call: put.key(),
                amount,
                release_slot: end,
                bump: ctx.bumps.lock,
            });
        } else {
            require_keys_eq!(lock.locker, ctx.accounts.buyer.key(), OnceError::NotLocker);
            require_eq!(lock.release_slot, end, OnceError::InvalidValue);
            lock.amount = lock.amount.checked_add(amount).ok_or(OnceError::Overflow)?;
        }
        transfer(
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.payment_source.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.payment_destination.to_account_info(),
            ctx.accounts.buyer.to_account_info(),
            price,
            ctx.accounts.usdc_mint.decimals,
            &[],
        )?;
        let seller = ctx.accounts.listing.seller;
        put.holder = Some(ctx.accounts.buyer.key());
        put.bought_slot = clock.slot;
        emit_cpi!(PutResold {
            put: put.key(),
            id: put.id,
            seller,
            buyer: ctx.accounts.buyer.key(),
            price,
            slot: clock.slot,
            locked: amount
        });
        Ok(())
    }

    pub fn close_out(ctx: Context<CloseOut>) -> Result<()> {
        let call = &mut ctx.accounts.call;
        let returned = ctx.accounts.vault.amount;
        settle(
            call,
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            returned,
            ctx.accounts.mint.decimals,
        )?;
        // A close-out ends as Cancelled with the writer as holder; CallState keeps its five values.
        call.state = CallState::Cancelled;
        call.settled_slot = Clock::get()?.slot;
        emit_cpi!(ClosedOut {
            call: call.key(),
            id: call.id,
            writer: call.writer,
            returned,
            slot: call.settled_slot
        });
        Ok(())
    }

    pub fn close_out_put(ctx: Context<CloseOutPut>) -> Result<()> {
        let put = &mut ctx.accounts.put;
        let returned = ctx.accounts.vault.amount;
        settle_put(
            put,
            ctx.accounts.usdc_token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.usdc_mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            returned,
            ctx.accounts.usdc_mint.decimals,
        )?;
        put.state = CallState::Cancelled;
        put.settled_slot = Clock::get()?.slot;
        emit_cpi!(PutClosedOut {
            put: put.key(),
            id: put.id,
            writer: put.writer,
            returned,
            slot: put.settled_slot
        });
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn transfer<'info>(
    program: Pubkey,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            program,
            TransferChecked {
                from,
                mint,
                to,
                authority,
            },
            seeds,
        ),
        amount,
        decimals,
    )
}

fn close<'info>(
    program: Pubkey,
    account: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    token_interface::close_account(CpiContext::new_with_signer(
        program,
        CloseAccount {
            account,
            destination,
            authority,
        },
        seeds,
    ))
}

#[allow(clippy::too_many_arguments)]
fn settle<'info>(
    call: &Account<'info, Call>,
    program: Pubkey,
    vault: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    writer: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let id = call.id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"call", &id, &[call.bump]];
    transfer(
        program,
        vault.clone(),
        mint,
        destination,
        call.to_account_info(),
        amount,
        decimals,
        &[seeds],
    )?;
    close(program, vault, writer, call.to_account_info(), &[seeds])
}

#[allow(clippy::too_many_arguments)]
fn settle_put<'info>(
    put: &Account<'info, Put>,
    program: Pubkey,
    vault: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    writer: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let id = put.id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"put", &id, &[put.bump]];
    transfer(
        program,
        vault.clone(),
        mint,
        destination,
        put.to_account_info(),
        amount,
        decimals,
        &[seeds],
    )?;
    close(program, vault, writer, put.to_account_info(), &[seeds])
}
