use super::types::{FoodRateAcc, LocalSeat, WsOut};
use tokio::sync::mpsc::UnboundedSender;

pub struct Conn {
    pub tx: UnboundedSender<WsOut>,
    // Indexed by local seat; None = a hole left by a leave (rejoin fills it).
    pub locals: Vec<Option<LocalSeat>>,
    pub initials: Vec<Option<String>>,
    pub food_rate: Vec<Option<FoodRateAcc>>,
}

impl Conn {
    // JS conn.locals[i] tolerates out-of-range reads; helpers to match.
    pub fn local(&self, i: usize) -> Option<&LocalSeat> {
        self.locals.get(i).and_then(|l| l.as_ref())
    }
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
