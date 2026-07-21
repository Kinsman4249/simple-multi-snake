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

pub struct Captcha {
    pending: HashMap<String, (i64, i64)>, // id -> (answer, expires_at)
    tokens: HashMap<String, i64>,         // token -> expires_at
    token_ttl_ms: i64,
}

pub fn random_hex(bytes: usize) -> String {
    let mut rng = rand::rng();
    (0..bytes).map(|_| format!("{:02x}", rng.random::<u8>())).collect()
}

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
