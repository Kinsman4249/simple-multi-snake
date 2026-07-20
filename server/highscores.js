// ============================================================
// High-score persistence: load/save, daily rollover, qualification check,
// record. Phase 12: TWO separate boards keyed by play MODE --
//   "local"     one computer (solo or couch co-op on a single connection)
//   "networked" two or more computers (connections with player seats)
// -- because racking up length against nobody and against live opponents
// are different skills and shouldn't rank together. The mode of a run is
// sampled at DEATH/LEAVE time (see scoreMode in lifecycle.js) and stored
// with the pending score, so a session changing shape later can't
// reclassify it.
//
// File shape v3: { version: 3, modes: { local: { date, daily, allTime,
// foodRateDaily, foodRateAllTime }, networked: { ... same ... } } } --
// per-mode date so the daily resets stay independent. foodRateDaily/
// foodRateAllTime (v3.7.0) are the speed-run / food-rate boards -- a second
// SCORE TYPE competed under the same local/networked split as the length
// boards, not a third mode. A flat v1 file ({ date, daily, allTime }) is
// migrated in-memory by wrapping it as modes.local (all history to date was
// overwhelmingly one-machine play; the networked board starts fresh and
// fair); a v2 file ({ version: 2, modes: {...} }) is migrated by adding
// empty foodRate boards to each mode. Both persist in v3 shape on the next
// save.
//
// The store path honors CFG.highscoresFile (default "highscores.json") so
// tests can point every server at its own temp file instead of polluting
// the repo's real board (tests/helpers.js startServer does this).
// ============================================================
const fs = require("fs");
const path = require("path");
const { ROOT, CFG } = require("./config");

const HS_FILE = path.join(ROOT, typeof CFG.highscoresFile === "string" && CFG.highscoresFile ? CFG.highscoresFile : "highscores.json");
const MODES = ["local", "networked"];

function todayStr() { return new Date().toISOString().slice(0, 10); }
function emptyBoard() { return { date: todayStr(), daily: [], allTime: [], foodRateDaily: [], foodRateAllTime: [] }; }
function loadHighScores() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(HS_FILE, "utf8")); }
  catch { raw = null; }
  let data;
  if (raw && raw.version === 3 && raw.modes) {
    data = raw;
  } else if (raw && raw.version === 2 && raw.modes) {
    // v2 -> v3: add the empty food-rate boards to each existing mode.
    data = { version: 3, modes: raw.modes };
  } else if (raw && Array.isArray(raw.daily)) {
    // v1 flat store: wrap as the local board (see module comment).
    data = { version: 3, modes: { local: { date: raw.date || todayStr(), daily: raw.daily, allTime: raw.allTime || [] }, networked: emptyBoard() } };
  } else {
    data = { version: 3, modes: { local: emptyBoard(), networked: emptyBoard() } };
  }
  for (const m of MODES) {
    if (!data.modes[m]) data.modes[m] = emptyBoard();
    if (!Array.isArray(data.modes[m].foodRateDaily)) data.modes[m].foodRateDaily = [];
    if (!Array.isArray(data.modes[m].foodRateAllTime)) data.modes[m].foodRateAllTime = [];
    if (data.modes[m].date !== todayStr()) { data.modes[m].date = todayStr(); data.modes[m].daily = []; data.modes[m].foodRateDaily = []; }
  }
  return data;
}
function saveHighScores(data) { fs.writeFileSync(HS_FILE, JSON.stringify(data, null, 2)); }
let highScores = loadHighScores();
function getHighScores() { return highScores; }
// kind: "length" (default, the daily/allTime boards) or "foodRate"
// (foodRateDaily/foodRateAllTime) -- see the file-shape comment above.
function qualifies(score, mode, kind = "length") {
  const targets = [];
  if (score <= 0) return targets;
  const b = highScores.modes[MODES.includes(mode) ? mode : "local"];
  const dailyKey = kind === "foodRate" ? "foodRateDaily" : "daily";
  const allKey = kind === "foodRate" ? "foodRateAllTime" : "allTime";
  if (b[dailyKey].length < 5 || score > b[dailyKey][b[dailyKey].length - 1].score) targets.push(dailyKey);
  if (b[allKey].length < 5 || score > b[allKey][b[allKey].length - 1].score) targets.push(allKey);
  return targets;
}
function recordScore(targets, initials, score, mode) {
  highScores = loadHighScores();
  const b = highScores.modes[MODES.includes(mode) ? mode : "local"];
  for (const board of targets) {
    b[board].push({ initials, score });
    b[board].sort((a, c) => c.score - a.score);
    b[board] = b[board].slice(0, 5);
  }
  saveHighScores(highScores);
}

module.exports = { getHighScores, qualifies, recordScore };
