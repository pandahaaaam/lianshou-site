// 练手交易所 · 排行榜后端（Netlify Function + Netlify Blobs）
//
// GET  /api/leaderboard?id=<玩家id>         → 总榜（按收益率排名）+ 小赛季 / 大赛季榜，带上“我”的名次
// POST /api/leaderboard {id, token, name, initial, equity, trades, ach, lv, created, rb, join?, leave?}
//      rb = 重生次数（重新开始的次数），榜单上显示为「第 rb+1 世」。
//      起始资金统一为 $10,000；旧成绩按比例换算（收益率不变）。
//
// 赛季：每 2 天一个小赛季、每 10 天一个大赛季（按 UTC 时间整齐切分）。
// 赛季收益 =（现在的总资产 − 赛季开始时的总资产）÷ 起始资金。赛季结束时前三名进入“往届冠军”。
//      第一次提交时登记 token（只存它的哈希），之后只有持有同一个 token 的人能更新或删除这条成绩。
import { getStore } from "@netlify/blobs";

const MAX_PLAYERS = 1000;
const TOP_N = 50;
const ID_RE = /^[a-z0-9]{16,40}$/;
const BOARD_KEY = "board";
const DAY = 86400e3;
const SEASON = { s: 2 * DAY, S: 10 * DAY };   // s = 小赛季, S = 大赛季
const KEEP_PAST = 8;
const sid = (k, t) => Math.floor(t / SEASON[k]);
const CAPITAL = 10000;
// older records used other starting amounts: scale them to $10,000, keeping the return the same
// Plausibility limits. The game runs in the player's browser, so a save can be edited by hand; these
// limits keep obviously impossible numbers off the board.
const MAX_EQUITY = 1e9;        // 100,000× the starting money: nothing above this is reachable in play
const GROWTH = 3, STEP = 600e3, MAX_STEPS = 6, ALLOWANCE = 30000;   // at most ×3 per 10 minutes, ×729 per upload at most
// Return across all lives: every life counts as another $10,000 put in, so restarting until one lucky
// life can't erase the losses of the others.  ratio = (final equity of past lives + this life) / (10,000 × lives)
const ratioOf = (r) => ((r.carried || 0) + r.equity) / (CAPITAL * (r.lives || 1));
// One-off account resets for records left over from old saves. The player's game sees me.fix and
// starts a fresh $10,000 life once, so its next upload matches.
const FIXES = [
  { id: "reset-20261004-1", name: "买英杰号,找高祖父" },
];
function resetRecord(r) {
  r.equity = CAPITAL; r.carried = 0; r.lives = 1; r.flagged = (r.flagged || 0) + 1; r.resetAt = Date.now(); r.fresh = 1;
  for (const s of ["s", "S"]) if (r[s]) r[s] = { ...r[s], start: CAPITAL };
  r.ratio = ratioOf(r);
}
function applyFixes(r) {
  for (const f of FIXES) {
    if ((r.fixes || []).includes(f.id) || String(r.name || "").normalize("NFKC") !== f.name.normalize("NFKC")) continue;
    resetRecord(r); r.fixes = [...(r.fixes || []), f.id]; r.fix = { id: f.id, reset: true };
  }
}
function norm(r) {
  if (!r) return r;
  applyFixes(r);
  if (r.initial && Math.abs(r.initial - CAPITAL) >= 0.5) {
    const k = CAPITAL / r.initial;
    r.equity = Math.round(r.equity * k * 100) / 100; r.initial = CAPITAL;
    for (const s of ["s", "S"]) if (r[s] && typeof r[s].start === "number") r[s] = { ...r[s], start: r[s].start * k };
  }
  // impossible numbers (edited saves) are wiped back to a fresh $10,000
  if (!isFinite(r.equity) || r.equity > MAX_EQUITY || !isFinite(r.carried || 0) || (r.carried || 0) > MAX_EQUITY * 100) resetRecord(r);
  r.ratio = ratioOf(r);
  return r;
}

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function cleanName(n) {
  n = String(n ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f<>"'`\\]/g, "").replace(/\s+/g, " ").trim();
  return [...n].slice(0, 16).join("");
}
function pub(rec) {
  return { id: rec.id, name: rec.name, initial: rec.initial, equity: rec.equity, ratio: rec.ratio,
           carried: rec.carried || 0, lives: rec.lives || 1, flagged: rec.flagged || 0, ok: rec.ok || 0,
           fixes: rec.fixes || [], fix: rec.fix || null, trades: rec.trades, ach: rec.ach, lv: rec.lv || 1, created: rec.created || 0, rb: rec.rb || 0,
           s: rec.s || null, S: rec.S || null, joinedAt: rec.joinedAt, updatedAt: rec.updatedAt };
}
const gainOf = (r, k) => (r.equity - r[k].start) / r.initial;
function seasonRows(board, k, id) {
  const rows = Object.values(board.players).filter((r) => r[k] && r[k].id === id);
  rows.sort((a, b) => gainOf(b, k) - gainOf(a, k) || a.joinedAt - b.joinedAt);
  return rows;
}
// archive the top 3 of any season that has ended (called before every read / write)
function roll(board, now) {
  if (!board.cur) board.cur = {};
  if (!board.past) board.past = { s: [], S: [] };
  let changed = false;
  for (const k of ["s", "S"]) {
    const id = sid(k, now), old = board.cur[k];
    if (old === id) continue;
    if (old != null && old < id) {
      const top = seasonRows(board, k, old).slice(0, 3).map((r, i) => ({ rank: i + 1, pid: r.id, name: r.name, lv: r.lv || 1, gain: gainOf(r, k) }));
      if (top.length) { board.past[k].unshift({ id: old, top }); board.past[k] = board.past[k].slice(0, KEEP_PAST); }
    }
    board.cur[k] = id; changed = true;
  }
  return changed;
}
function view(board, id) {
  const now = Date.now();
  const rows = Object.values(board.players || {});
  rows.sort((a, b) => b.ratio - a.ratio || a.joinedAt - b.joinedAt);
  const out = rows.map((r, i) => ({
    rank: i + 1, name: r.name, initial: r.initial, equity: r.equity, ratio: r.ratio, lives: r.lives || 1, lv: r.lv || 1, rb: r.rb || 0,
    trades: r.trades, ach: r.ach, updatedAt: r.updatedAt, me: !!id && r.id === id,
    ...(id && r.id === id && r.fix ? { fix: r.fix } : {}),
  }));
  const seasons = {};
  for (const k of ["s", "S"]) {
    const n = sid(k, now);
    const so = seasonRows(board, k, n).map((r, i) => ({
      rank: i + 1, name: r.name, initial: r.initial, equity: r.equity, gain: gainOf(r, k), lv: r.lv || 1, rb: r.rb || 0,
      trades: r.trades, updatedAt: r.updatedAt, me: !!id && r.id === id,
    }));
    seasons[k] = { id: n, start: n * SEASON[k], end: (n + 1) * SEASON[k], total: so.length,
                   top: so.slice(0, TOP_N), me: so.find((r) => r.me) || null };
  }
  const past = {};
  // past champions: drop impossible results (edited saves) and re-rank what's left
  for (const k of ["s", "S"]) past[k] = ((board.past && board.past[k]) || []).map((p) => ({
    id: p.id, top: p.top.filter((t) => isFinite(t.gain) && t.gain <= MAX_EQUITY / CAPITAL && !(board.players[t.pid] && board.players[t.pid].flagged))
      .map((t, i) => ({ rank: i + 1, name: t.name, lv: t.lv, gain: t.gain, me: !!id && t.pid === id })) })).filter((p) => p.top.length);
  return { total: out.length, top: out.slice(0, TOP_N), me: out.find((r) => r.me) || null,
           seasons, past, updatedAt: now };
}

let cache = { t: 0, board: null };
async function readBoard(store, fresh) {
  if (!fresh && cache.board && Date.now() - cache.t < 3000) return cache.board;
  const b = (await store.get(BOARD_KEY, { type: "json" })) || { v: 1, players: {} };
  if (!b.players) b.players = {};
  Object.values(b.players).forEach(norm);
  cache = { t: Date.now(), board: b };
  return b;
}
async function writeBoard(store, board) {
  await store.setJSON(BOARD_KEY, board);
  cache = { t: Date.now(), board };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  const store = getStore({ name: "leaderboard", consistency: "strong" });

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") || "";
    let board = await readBoard(store, false);
    if (roll(board, Date.now())) { board = await readBoard(store, true); if (roll(board, Date.now())) await writeBoard(store, board); }
    // A lost update (two players saving at the same instant) is repaired from the player's own record.
    if (ID_RE.test(id) && !board.players[id]) {
      const rec = await store.get("p/" + id, { type: "json" });
      if (rec) { const b = await readBoard(store, true); b.players[id] = pub(norm(rec)); await writeBoard(store, b); return json(view(b, id)); }
    }
    return json(view(board, ID_RE.test(id) ? id : null));
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const raw = await req.text();
  if (raw.length > 4000) return json({ error: "too_large" }, 413);
  let b;
  try { b = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }

  const id = String(b.id || ""), token = String(b.token || "");
  if (!ID_RE.test(id) || token.length < 16 || token.length > 100) return json({ error: "bad_id", message: "身份信息不正确" }, 400);
  const key = "p/" + id;
  const existing = norm(await store.get(key, { type: "json" }));
  const tokenHash = await sha256(token);
  if (existing && existing.tokenHash !== tokenHash) return json({ error: "forbidden", message: "这条成绩不属于你" }, 403);

  if (b.leave) {
    if (existing) await store.delete(key);
    const board = await readBoard(store, true);
    delete board.players[id];
    await writeBoard(store, board);
    return json({ ok: true, board: view(board, null) });
  }

  // a save converted from an old non-$10,000 start can't be on the board; its record (if any) is wiped
  if (b.legacy) {
    if (existing) {
      resetRecord(existing); existing.legacy = 1; await store.setJSON(key, existing);
      const bd = await readBoard(store, true); if (bd.players[id]) { bd.players[id] = pub(existing); await writeBoard(store, bd); }
    }
    return json({ error: "legacy_save", message: "这个存档来自旧版本，当时的起始资金不是 $10,000，不能上榜。重新开始一世就能参加排行。" }, 409);
  }
  const name = cleanName(b.name);
  if (!name) return json({ error: "bad_name", message: "名字不能为空" }, 400);
  const initial = Number(b.initial), equity = Number(b.equity);
  // equity may be negative: gap losses and loan interest can leave a player owing money
  if (Math.abs(initial - CAPITAL) > 0.5)
    return json({ error: "old_version", message: "游戏已更新，请刷新网页" }, 400);
  if (!isFinite(equity) || equity > MAX_EQUITY || equity < -MAX_EQUITY)
    return json({ error: "implausible", message: "成绩超出了游戏里可能达到的范围，没有上传" }, 400);
  const trades = Math.max(0, Math.min(1e7, Math.floor(Number(b.trades) || 0)));
  const ach = Math.max(0, Math.min(100, Math.floor(Number(b.ach) || 0)));
  const lv = Math.max(1, Math.min(20, Math.floor(Number(b.lv) || 1)));
  const created = Math.max(0, Math.floor(Number(b.created) || 0));
  const rb = Math.max(0, Math.min(9999, Math.floor(Number(b.rb) || 0)));

  const board = await readBoard(store, true);
  roll(board, Date.now());
  if (!existing && Object.keys(board.players).length >= MAX_PLAYERS)
    return json({ error: "full", message: "榜单人数已满" }, 409);
  const lower = name.toLowerCase();
  if (Object.values(board.players).some((r) => r.id !== id && r.name.toLowerCase() === lower))
    return json({ error: "name_taken", message: "这个名字已经有人用了，换一个吧" }, 409);

  const now = Date.now();
  if (existing && !b.join && existing.name === name && now - (existing.updatedAt || 0) < 5000 && board.players[id])
    return json({ ok: true, throttled: true, board: view(board, id) });

  // season baselines: equity when the player first shows up in a season. A new game (different
  // `created`) starts its seasons from the new capital, so a restart can't fake a season gain.
  const eq = Math.round(equity * 100) / 100;
  const sameGame = existing && (!existing.created || existing.created === created);   // old records have no `created`
  // how much could this player plausibly have now? (a new life restarts from $10,000)
  const from = existing ? Math.max(sameGame ? existing.equity : CAPITAL, CAPITAL) : CAPITAL;
  const steps = existing ? Math.min(MAX_STEPS, Math.max(1, (now - Math.max(existing.updatedAt || now, existing.resetAt || 0)) / STEP)) : 1;
  const allowed = existing ? (from + ALLOWANCE) * Math.pow(GROWTH, steps) : MAX_EQUITY;
  if (eq > allowed)
    return json({ error: "implausible", message: "资产涨得比游戏里可能的还快，这次成绩没有上传" }, 400);
  // lives: a restart closes the previous life at its last reported equity
  // after a reset (fresh), the player's next new life counts as their first
  const restart = existing && !sameGame, fresh = existing && existing.fresh;
  const lives = !existing ? 1 : restart ? (fresh ? 1 : (existing.lives || 1) + 1) : (existing.lives || 1);
  const carried = !existing ? 0 : restart ? (fresh ? 0 : (existing.carried || 0) + existing.equity) : (existing.carried || 0);
  const base = {};
  for (const k of ["s", "S"]) {
    const n = sid(k, now), old = existing && existing[k];
    if (sameGame && old && old.id === n) base[k] = old;
    // restarted (重生) mid-season: carry this season's result over, so a restart can't erase a loss
    else if (!sameGame && existing && old && old.id === n) base[k] = { id: n, start: eq - (existing.equity - old.start) };
    else base[k] = { id: n, start: sameGame ? existing.equity : eq };
  }
  const rec = { id, tokenHash, name, initial, equity: eq, carried, lives, ratio: (carried + eq) / (CAPITAL * lives), trades, ach, lv, created, rb,
                flagged: existing?.flagged || 0, ok: 1, fixes: existing?.fixes || [], fix: existing?.fix || null,
                fresh: (existing?.fresh && !restart) ? 1 : 0,
                s: base.s, S: base.S, joinedAt: existing?.joinedAt || now, updatedAt: now };
  await store.setJSON(key, rec);
  board.players[id] = pub(rec);
  await writeBoard(store, board);
  return json({ ok: true, board: view(board, id) });
};

export const config = { path: "/api/leaderboard" };
