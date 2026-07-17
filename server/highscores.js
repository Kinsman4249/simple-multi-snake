// ============================================================
// High-score persistence (highscores.json): load/save, daily rollover,
// qualification check, record. The mutable board state lives INSIDE this
// module; readers use getHighScores().
// ============================================================
const fs = require("fs");
const path = require("path");
const { ROOT } = require("./config");

const HS_FILE = path.join(ROOT, "highscores.json");

function todayStr() { return new Date().toISOString().slice(0, 10); }
function loadHighScores() {
  let data;
  try { data = JSON.parse(fs.readFileSync(HS_FILE, "utf8")); }
  catch { data = { date: todayStr(), daily: [], allTime: [] }; }
  if (data.date !== todayStr()) { data.date = todayStr(); data.daily = []; }
  return data;
}
function saveHighScores(data) { fs.writeFileSync(HS_FILE, JSON.stringify(data, null, 2)); }
let highScores = loadHighScores();
function getHighScores() { return highScores; }
function qualifies(score) {
  const targets = [];
  if (score <= 0) return targets;
  if (highScores.daily.length < 5 || score > highScores.daily[highScores.daily.length - 1].score) targets.push("daily");
  if (highScores.allTime.length < 5 || score > highScores.allTime[highScores.allTime.length - 1].score) targets.push("allTime");
  return targets;
}
function recordScore(targets, initials, score) {
  highScores = loadHighScores();
  for (const board of targets) {
    highScores[board].push({ initials, score });
    highScores[board].sort((a, b) => b.score - a.score);
    highScores[board] = highScores[board].slice(0, 5);
  }
  saveHighScores(highScores);
}

module.exports = { getHighScores, qualifies, recordScore };
