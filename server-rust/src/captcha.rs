// ============================================================
// Captcha + one-shot join tokens (port of server/captcha.js). The JS used
// setTimeout to expire pending captchas; here every entry carries its
// deadline and expired ones are dropped lazily on access -- same observable
// behavior, no timers.
// ============================================================
use crate::config::now_ms;
use rand::Rng;
use std::collections::HashMap;

const CAPTCHA_TTL_MS: i64 = 120000;

// A `struct` bundling this type's state (see RUST-CHEATSHEET.md,
// "struct and enum"). No `pub` on the fields, so only code inside this
// module can read/write them directly -- everyone else must go through
// the methods in the `impl Captcha` block below.
pub struct Captcha {
    pending: HashMap<String, (i64, i64)>, // id -> (answer, expires_at)
    tokens: HashMap<String, i64>,         // token -> expires_at
    token_ttl_ms: i64,
}

pub fn random_hex(bytes: usize) -> String {
    let mut rng = rand::rng();
    (0..bytes).map(|_| format!("{:02x}", rng.random::<u8>())).collect()
}

// impl block: where Captcha's methods live, separate from the struct's
// field declaration above; see RUST-CHEATSHEET.md ("impl blocks").
//
// Overall flow (see ws.rs / routes.rs for callers):
//   1. make() -- generate an addition puzzle ("a + b = ?"), remember the
//      expected answer keyed by a random id, hand (id, a, b) to the client.
//   2. verify() -- client posts back id + their answer; if it matches
//      (and hasn't expired) this returns true and the pending entry is
//      consumed (one-shot: can't be verified twice).
//   3. issue_token() -- on a successful verify, the caller mints a
//      short-lived join token.
//   4. consume_token() -- the WebSocket handshake spends that token once,
//      proving "this connection passed a captcha recently".
impl Captcha {
    pub fn new(token_ttl_ms: i64) -> Captcha {
        Captcha { pending: HashMap::new(), tokens: HashMap::new(), token_ttl_ms }
    }

    pub fn make(&mut self) -> (String, i64, i64) {
        let now = now_ms();
        // Lazy sweep so an unattended server can't accumulate entries.
        self.pending.retain(|_, (_, exp)| *exp > now);
        let mut rng = rand::rng();
        let a = 1 + rng.random_range(0..9i64);
        let b = 1 + rng.random_range(0..9i64);
        let id = random_hex(8);
        self.pending.insert(id.clone(), (a + b, now + CAPTCHA_TTL_MS));
        (id, a, b)
    }

    pub fn verify(&mut self, id: &str, answer: i64) -> bool {
        let now = now_ms();
        // .remove() both looks up AND deletes the entry, returning it as an
        // Option -- so a verify attempt always consumes the pending puzzle,
        // win or lose (one-shot). match handles the found/not-found cases;
        // see RUST-CHEATSHEET.md ("Option<T>", "match").
        match self.pending.remove(id) {
            Some((expected, exp)) => exp > now && answer == expected,
            None => false,
        }
    }

    pub fn issue_token(&mut self) -> String {
        let now = now_ms();
        self.tokens.retain(|_, exp| *exp > now);
        let token = random_hex(16);
        self.tokens.insert(token.clone(), now + self.token_ttl_ms);
        token
    }

    pub fn consume_token(&mut self, token: &str) -> bool {
        match self.tokens.remove(token) {
            Some(exp) => now_ms() < exp,
            None => false,
        }
    }
}
