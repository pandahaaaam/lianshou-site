// 练手交易所 · 排行榜后端（Netlify Function + Netlify Blobs）
//
// GET  /api/leaderboard?id=<玩家id>         → 榜单（按收益率排名），带上“我”的名次
// POST /api/leaderboard {id, token, name, initial, equity, trades, ach, join?, leave?}
//      第一次提交时登记 token（只存它的哈希），之后只有持有同一个 token 的人能更新或删除这条成绩。
import { getStore } from "@netlify/blobs";

const MAX_PLAYERS = 1000;
const TOP_N = 50;
const ID_RE = /^[a-z0-9]{16,40}$/;
const BOARD_KEY = "board";

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
           trades: rec.trades, ach: rec.ach, joinedAt: rec.joinedAt, updatedAt: rec.updatedAt };
}
function view(board, id) {
  const rows = Object.values(board.players || {});
  rows.sort((a, b) => b.ratio - a.ratio || a.joinedAt - b.joinedAt);
  const out = rows.map((r, i) => ({
    rank: i + 1, name: r.name, initial: r.initial, equity: r.equity, ratio: r.ratio,
    trades: r.trades, ach: r.ach, updatedAt: r.updatedAt, me: !!id && r.id === id,
  }));
  return { total: out.length, top: out.slice(0, TOP_N), me: out.find((r) => r.me) || null, updatedAt: Date.now() };
}

let cache = { t: 0, board: null };
async function readBoard(store, fresh) {
  if (!fresh && cache.board && Date.now() - cache.t < 3000) return cache.board;
  const b = (await store.get(BOARD_KEY, { type: "json" })) || { v: 1, players: {} };
  if (!b.players) b.players = {};
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
    const board = await readBoard(store, false);
    // A lost update (two players saving at the same instant) is repaired from the player's own record.
    if (ID_RE.test(id) && !board.players[id]) {
      const rec = await store.get("p/" + id, { type: "json" });
      if (rec) { const b = await readBoard(store, true); b.players[id] = pub(rec); await writeBoard(store, b); return json(view(b, id)); }
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
  const existing = await store.get(key, { type: "json" });
  const tokenHash = await sha256(token);
  if (existing && existing.tokenHash !== tokenHash) return json({ error: "forbidden", message: "这条成绩不属于你" }, 403);

  if (b.leave) {
    if (existing) await store.delete(key);
    const board = await readBoard(store, true);
    delete board.players[id];
    await writeBoard(store, board);
    return json({ ok: true, board: view(board, null) });
  }

  const name = cleanName(b.name);
  if (!name) return json({ error: "bad_name", message: "名字不能为空" }, 400);
  const initial = Number(b.initial), equity = Number(b.equity);
  if (!(initial >= 100 && initial <= 1e9) || !(equity >= 0 && equity <= initial * 1e6))
    return json({ error: "bad_numbers", message: "成绩数据不正确" }, 400);
  const trades = Math.max(0, Math.min(1e7, Math.floor(Number(b.trades) || 0)));
  const ach = Math.max(0, Math.min(100, Math.floor(Number(b.ach) || 0)));

  const board = await readBoard(store, true);
  if (!existing && Object.keys(board.players).length >= MAX_PLAYERS)
    return json({ error: "full", message: "榜单人数已满" }, 409);
  const lower = name.toLowerCase();
  if (Object.values(board.players).some((r) => r.id !== id && r.name.toLowerCase() === lower))
    return json({ error: "name_taken", message: "这个名字已经有人用了，换一个吧" }, 409);

  const now = Date.now();
  if (existing && !b.join && existing.name === name && now - (existing.updatedAt || 0) < 5000 && board.players[id])
    return json({ ok: true, throttled: true, board: view(board, id) });

  const rec = { id, tokenHash, name, initial, equity: Math.round(equity * 100) / 100, ratio: equity / initial,
                trades, ach, joinedAt: existing?.joinedAt || now, updatedAt: now };
  await store.setJSON(key, rec);
  board.players[id] = pub(rec);
  await writeBoard(store, board);
  return json({ ok: true, board: view(board, id) });
};

export const config = { path: "/api/leaderboard" };
