use anchor_lang::prelude::*;
use crate::state::OptionKind;

#[event]
pub struct Initialized {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub gate_slots: u64,
    pub lock_amount: u64,
}
#[event]
pub struct OnceSet {
    pub once_mint: Pubkey,
    pub once_token_program: Pubkey,
}
#[event]
pub struct ParamsSet {
    pub gate_slots: u64,
    pub lock_amount: u64,
}
#[event]
pub struct Written {
    pub call: Pubkey,
    pub id: u64,
    pub writer: Pubkey,
    pub mint: Pubkey,
    pub lot: u64,
    pub strike: u64,
    pub premium: u64,
    pub expiry_ts: i64,
    pub written_slot: u64,
    pub gate_until: u64,
}
#[event]
pub struct Bought {
    pub call: Pubkey,
    pub id: u64,
    pub holder: Pubkey,
    pub premium: u64,
    pub slot: u64,
    pub locked: u64,
}
#[event]
pub struct Exercised {
    pub call: Pubkey,
    pub id: u64,
    pub holder: Pubkey,
    pub writer: Pubkey,
    pub strike: u64,
    pub delivered: u64,
    pub slot: u64,
}
#[event]
pub struct Cancelled {
    pub call: Pubkey,
    pub id: u64,
    pub writer: Pubkey,
    pub returned: u64,
    pub slot: u64,
}
#[event]
pub struct Reclaimed {
    pub call: Pubkey,
    pub id: u64,
    pub writer: Pubkey,
    pub holder: Option<Pubkey>,
    pub returned: u64,
    pub slot: u64,
}
#[event]
pub struct LockReturned {
    pub call: Pubkey,
    pub locker: Pubkey,
    pub returned: u64,
    pub slot: u64,
}
#[event]
pub struct Listed {
    pub call: Pubkey,
    pub id: u64,
    pub seller: Pubkey,
    pub price: u64,
    pub slot: u64,
}
#[event]
pub struct Unlisted {
    pub call: Pubkey,
    pub seller: Pubkey,
    pub slot: u64,
}
#[event]
pub struct Resold {
    pub call: Pubkey,
    pub id: u64,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub slot: u64,
    pub locked: u64,
}
#[event]
pub struct ResaleLockReturned {
    pub call: Pubkey,
    pub locker: Pubkey,
    pub returned: u64,
    pub slot: u64,
}

#[event]
pub struct PutWritten {
    pub put: Pubkey,
    pub id: u64,
    pub writer: Pubkey,
    pub mint: Pubkey,
    pub lot: u64,
    pub strike: u64,
    pub premium: u64,
    pub expiry_ts: i64,
    pub written_slot: u64,
    pub gate_until: u64,
}

#[event]
pub struct PutBought {
    pub put: Pubkey,
    pub id: u64,
    pub holder: Pubkey,
    pub premium: u64,
    pub slot: u64,
    pub locked: u64,
}

#[event]
pub struct PutExercised {
    pub put: Pubkey,
    pub id: u64,
    pub holder: Pubkey,
    pub writer: Pubkey,
    pub delivered: u64,
    pub paid: u64,
    pub slot: u64,
}

#[event]
pub struct PutCancelled {
    pub put: Pubkey,
    pub id: u64,
    pub writer: Pubkey,
    pub returned: u64,
    pub slot: u64,
}

#[event]
pub struct PutReclaimed {
    pub put: Pubkey,
    pub id: u64,
    pub writer: Pubkey,
    pub holder: Option<Pubkey>,
    pub returned: u64,
    pub slot: u64,
}

#[event]
pub struct PutListed {
    pub put: Pubkey,
    pub id: u64,
    pub seller: Pubkey,
    pub price: u64,
    pub slot: u64,
}

#[event]
pub struct PutResold {
    pub put: Pubkey,
    pub id: u64,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub slot: u64,
    pub locked: u64,
}

#[event]
pub struct ClosedOut {
    pub call: Pubkey,
    pub id: u64,
    pub writer: Pubkey,
    pub returned: u64,
    pub slot: u64,
}

#[event]
pub struct PutClosedOut {
    pub put: Pubkey,
    pub id: u64,
    pub writer: Pubkey,
    pub returned: u64,
    pub slot: u64,
}

#[event]
pub struct OrderPlaced {
    pub order: Pubkey,
    pub buyer: Pubkey,
    pub nonce: u64,
    pub kind: OptionKind,
    pub mint: Pubkey,
    pub lot: u64,
    pub strike: u64,
    pub premium: u64,
    pub expiry_ts: i64,
    pub locked: u64,
    pub slot: u64,
}

#[event]
pub struct OrderCancelled {
    pub order: Pubkey,
    pub buyer: Pubkey,
    pub premium: u64,
    pub unlocked: u64,
    pub slot: u64,
}

#[event]
pub struct OrderFilled {
    pub order: Pubkey,
    pub kind: OptionKind,
    pub option: Pubkey,
    pub id: u64,
    pub writer: Pubkey,
    pub holder: Pubkey,
    pub premium: u64,
    pub deposited: u64,
    pub locked: u64,
    pub slot: u64,
    pub gate_until: u64,
}
