// ============================================================
// High-score persistence (port of server/highscores.js). Two boards keyed
// by play mode ("local" / "networked"), each with length (daily/allTime)
// and food-rate (foodRateDaily/foodRateAllTime) top-5 lists. File shape v3
// on disk; v1/v2 files are migrated in memory and persist as v3 on save.
// ============================================================
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
pub struct Entry {
    pub initials: String,
    // Length scores are integers, food-rate scores have decimals; JSON
    // doesn't care, so store f64 and serialize 12.0 as 12 below.
    #[serde(serialize_with = "ser_score")]
    pub score: f64,
}

// JS JSON.stringify(12) emits "12", never "12.0" -- match it so a
// re-written highscores.json stays diff-clean against the node server's.
fn ser_score<S: serde::Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if v.fract() == 0.0 && v.abs() < 9e15 {
        s.serialize_i64(*v as i64)
    } else {
        s.serialize_f64(*v)
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Board {
    pub date: String,
    pub daily: Vec<Entry>,
    #[serde(rename = "allTime")]
    pub all_time: Vec<Entry>,
    #[serde(rename = "foodRateDaily", default)]
    pub food_rate_daily: Vec<Entry>,
    #[serde(rename = "foodRateAllTime", default)]
    pub food_rate_all_time: Vec<Entry>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Store {
    pub version: i64,
    pub modes: Modes,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Modes {
    pub local: Board,
    pub networked: Board,
}

pub struct HighScores {
    path: PathBuf,
    pub data: Store,
}

// Days-since-epoch to civil date (Howard Hinnant's algorithm) -- keeps the
// UTC yyyy-mm-dd stamp without pulling in chrono.
fn today_str() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let z = secs.div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn empty_board() -> Board {
    Board {
        date: today_str(),
        daily: vec![],
        all_time: vec![],
        food_rate_daily: vec![],
        food_rate_all_time: vec![],
    }
}

fn load_store(path: &PathBuf) -> Store {
    let raw: Option<serde_json::Value> = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    let mut data: Store = match raw {
        Some(v) => {
            let version = v.get("version").and_then(|x| x.as_i64()).unwrap_or(0);
            if (version == 3 || version == 2) && v.get("modes").is_some() {
                // v2 -> v3 falls out of the serde defaults on the food-rate
                // arrays.
                match serde_json::from_value::<Modes>(v.get("modes").cloned().unwrap()) {
                    Ok(modes) => Store { version: 3, modes },
                    Err(_) => Store { version: 3, modes: Modes { local: empty_board(), networked: empty_board() } },
                }
            } else if v.get("daily").map_or(false, |d| d.is_array()) {
                // v1 flat store: wrap as the local board.
                let date = v.get("date").and_then(|x| x.as_str()).map(String::from).unwrap_or_else(today_str);
                let daily = serde_json::from_value(v.get("daily").cloned().unwrap()).unwrap_or_default();
                let all_time = v
                    .get("allTime")
                    .cloned()
                    .and_then(|x| serde_json::from_value(x).ok())
                    .unwrap_or_default();
                Store {
                    version: 3,
                    modes: Modes {
                        local: Board { date, daily, all_time, food_rate_daily: vec![], food_rate_all_time: vec![] },
                        networked: empty_board(),
                    },
                }
            } else {
                Store { version: 3, modes: Modes { local: empty_board(), networked: empty_board() } }
            }
        }
        None => Store { version: 3, modes: Modes { local: empty_board(), networked: empty_board() } },
    };
    // Daily rollover, per mode.
    for board in [&mut data.modes.local, &mut data.modes.networked] {
        if board.date != today_str() {
            board.date = today_str();
            board.daily.clear();
            board.food_rate_daily.clear();
        }
    }
    data
}

impl HighScores {
    pub fn open(path: PathBuf) -> HighScores {
        let data = load_store(&path);
        HighScores { path, data }
    }

    fn board(&self, mode: &str) -> &Board {
        if mode == "networked" {
            &self.data.modes.networked
        } else {
            &self.data.modes.local
        }
    }
    fn board_mut(&mut self, mode: &str) -> &mut Board {
        if mode == "networked" {
            &mut self.data.modes.networked
        } else {
            &mut self.data.modes.local
        }
    }

    // Which lists a score would enter. kind: "length" or "foodRate".
    pub fn qualifies(&self, score: f64, mode: &str, kind: &str) -> Vec<&'static str> {
        let mut targets = Vec::new();
        if score <= 0.0 {
            return targets;
        }
        let b = self.board(mode);
        let (daily, all, daily_key, all_key): (&Vec<Entry>, &Vec<Entry>, &'static str, &'static str) =
            if kind == "foodRate" {
                (&b.food_rate_daily, &b.food_rate_all_time, "foodRateDaily", "foodRateAllTime")
            } else {
                (&b.daily, &b.all_time, "daily", "allTime")
            };
        if daily.len() < 5 || score > daily.last().unwrap().score {
            targets.push(daily_key);
        }
        if all.len() < 5 || score > all.last().unwrap().score {
            targets.push(all_key);
        }
        targets
    }

    pub fn record(&mut self, targets: &[&str], initials: &str, score: f64, mode: &str) {
        // Reload before writing, like the JS (another process may have
        // touched the file; also picks up a date rollover).
        self.data = load_store(&self.path);
        let b = self.board_mut(mode);
        for t in targets {
            let list = match *t {
                "foodRateDaily" => &mut b.food_rate_daily,
                "foodRateAllTime" => &mut b.food_rate_all_time,
                "allTime" => &mut b.all_time,
                _ => &mut b.daily,
            };
            list.push(Entry { initials: initials.to_string(), score });
            list.sort_by(|a, c| c.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
            list.truncate(5);
        }
        let json = serde_json::to_string_pretty(&self.data).unwrap();
        let _ = std::fs::write(&self.path, json);
    }
}
