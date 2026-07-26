// crate::state::types is imported via a relative `super::` path here (this
// file lives one level below the crate root's `state` module) -- see
// "Modules" in docs/RUST-CHEATSHEET.md.
use super::types::{FoodRateAcc, LocalSeat, WsOut};
use tokio::sync::mpsc::UnboundedSender;

pub struct Conn {
    pub tx: UnboundedSender<WsOut>,
    // Indexed by local seat; None = a hole left by a leave (rejoin fills it).
    // Vec<Option<T>> ("maybe a seat, maybe an empty hole") -- see Vec and
    // Option<T> in RUST-CHEATSHEET.md.
    pub locals: Vec<Option<LocalSeat>>,
    pub initials: Vec<Option<String>>,
    pub food_rate: Vec<Option<FoodRateAcc>>,
}

// impl block: where Conn's methods live, separate from its field list above
// -- see "impl blocks" in RUST-CHEATSHEET.md.
impl Conn {
    // JS conn.locals[i] tolerates out-of-range reads; helpers to match.
    // &self borrows the Conn read-only; .and_then chains a closure that only
    // runs if the .get(i) lookup found something -- see "References" and
    // "Option<T>" in RUST-CHEATSHEET.md.
    pub fn local(&self, i: usize) -> Option<&LocalSeat> {
        self.locals.get(i).and_then(|l| l.as_ref())
    }
    // &mut self borrows Conn mutably -- this method is allowed to modify it.
    pub fn set_local(&mut self, i: usize, seat: Option<LocalSeat>) {
        if self.locals.len() <= i {
            self.locals.resize(i + 1, None);
        }
        self.locals[i] = seat;
    }
    pub fn set_initials(&mut self, i: usize, v: String) {
        if self.initials.len() <= i {
            self.initials.resize(i + 1, None);
        }
        self.initials[i] = Some(v);
    }
    pub fn initials_for(&self, i: usize) -> &str {
        self.initials
            .get(i)
            .and_then(|s| s.as_deref())
            .unwrap_or("???")
    }
    pub fn any_seat_left(&self) -> bool {
        self.locals.iter().any(|l| l.is_some())
    }
}
