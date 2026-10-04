// 练手交易所 · 好友对战房（Netlify Function + Netlify Blobs）
//
// 开一个房间拿到 6 位邀请码，朋友输入邀请码加入。房间开 1 小时 / 1 天 / 3 天，
// 按「进房以后赚了多少」排名（每人起始资金都是 $10,000）。中途重生不会抹掉房间里的亏损。
//
// GET  /api/room?code=ABC234&id=<玩家id>      → 房间排名
// POST /api/room {action:"create", id, token, name, hours, equity, created, lv, rb}
//      {action:"join",   code, id, token, name, equity, created, lv, rb}
//      {action:"update", code, id, token, name, equity, created, lv, rb}
//      {action:"leave",  code, id, token}
import { getStore } from "@netlify/blobs";

const CAPITAL = 10000, MAX_MEMBERS = 20, HOURS = [1, 24, 72];
const MAX_EQUITY = 1e9, GROWTH = 3, STEP = 600e3, MAX_STEPS = 6, ALLOWANCE = 30000;   // same plausibility limits as the leaderboard
const ID_RE = /^[a-z0-9]{16,40}$/, CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const HEADERS = {
  "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
  "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type",
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
function newCode() { const a = new Uint8Array(6); crypto.getRandomValues(a); return [...a].map((x) => ALPHA[x % ALPHA.length]).join(""); }
const gain = (m) => (m.equity - m.start) / CAPITAL;
function view(room, id) {
  const now = Date.now();
  // impossible numbers (edited saves) count as no result at all
  for (const m of Object.values(room.members)) if (!isFinite(m.equity) || m.equity > MAX_EQUITY) { m.equity = CAPITAL; m.start = CAPITAL; }
  const rows = Object.values(room.members).sort((a, b) => gain(b) - gain(a) || a.joinedAt - b.joinedAt);
  return {
    code: room.code, hostName: room.hostName, hours: room.hours, createdAt: room.createdAt, endAt: room.endAt,
    ended: now >= room.endAt, total: rows.length, updatedAt: now,
    members: rows.map((m, i) => ({ rank: i + 1, name: m.name, lv: m.lv || 1, rb: m.rb || 0, gain: gain(m), equity: m.equity,
                                   updatedAt: m.updatedAt, host: m.id === room.host, me: !!id && m.id === id })),
  };
}
function nums(b) {
  const equity = Number(b.equity);
  if (!isFinite(equity) || Math.abs(equity) > MAX_EQUITY) return null;
  return { equity: Math.round(equity * 100) / 100, created: Math.max(0, Math.floor(Number(b.created) || 0)),
           lv: Math.max(1, Math.min(20, Math.floor(Number(b.lv) || 1))), rb: Math.max(0, Math.min(9999, Math.floor(Number(b.rb) || 0))) };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  const store = getStore({ name: "rooms", consistency: "strong" });
  if (req.method === "GET") {
    const u = new URL(req.url), code = String(u.searchParams.get("code") || "").toUpperCase(), id = u.searchParams.get("id") || "";
    if (!CODE_RE.test(code)) return json({ error: "bad_code", message: "邀请码不对" }, 400);
    const room = await store.get("r/" + code, { type: "json" });
    if (!room) return json({ error: "not_found", message: "没有这个房间" }, 404);
    return json(view(room, ID_RE.test(id) ? id : null));
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const raw = await req.text(); if (raw.length > 2000) return json({ error: "too_large" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
  const id = String(b.id || ""), token = String(b.token || ""), action = String(b.action || "");
  if (!ID_RE.test(id) || token.length < 16 || token.length > 100) return json({ error: "bad_id", message: "身份信息不正确" }, 400);
  const tokenHash = await sha256(token), now = Date.now();
  if (b.legacy && action !== "leave") return json({ error: "legacy_save", message: "旧版本修改过起始资金的存档不能参加对战房，重新开始一世就能参加。" }, 409);

  if (action === "create") {
    const name = cleanName(b.name), n = nums(b), hours = Number(b.hours);
    if (!name) return json({ error: "bad_name", message: "名字不能为空" }, 400);
    if (!n || !HOURS.includes(hours)) return json({ error: "bad_numbers", message: "数据不正确" }, 400);
    let code = newCode();
    for (let i = 0; i < 5 && (await store.get("r/" + code, { type: "json" })); i++) code = newCode();
    const room = { code, host: id, hostName: name, hours, createdAt: now, endAt: now + hours * 3600e3,
                   members: { [id]: { id, tokenHash, name, ...n, start: n.equity, joinedAt: now, updatedAt: now } } };
    await store.setJSON("r/" + code, room);
    return json({ ok: true, room: view(room, id) });
  }

  const code = String(b.code || "").toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: "bad_code", message: "邀请码是 6 位字母和数字" }, 400);
  const room = await store.get("r/" + code, { type: "json" });
  if (!room) return json({ error: "not_found", message: "没有这个房间，检查一下邀请码" }, 404);
  const m = room.members[id];
  if (m && m.tokenHash !== tokenHash) return json({ error: "forbidden", message: "身份不对" }, 403);

  if (action === "leave") {
    if (m) { delete room.members[id]; await store.setJSON("r/" + code, room); }
    return json({ ok: true });
  }
  const name = cleanName(b.name), n = nums(b);
  if (!name || !n) return json({ error: "bad_numbers", message: "数据不正确" }, 400);
  const ended = now >= room.endAt;

  if (action === "join") {
    if (m) return json({ ok: true, room: view(room, id) });
    if (ended) return json({ error: "ended", message: "这个房间已经结束了" }, 409);
    if (Object.keys(room.members).length >= MAX_MEMBERS) return json({ error: "full", message: `房间满了（最多 ${MAX_MEMBERS} 人）` }, 409);
    if (Object.values(room.members).some((x) => x.name.toLowerCase() === name.toLowerCase()))
      return json({ error: "name_taken", message: "房间里已经有人叫这个名字了" }, 409);
    room.members[id] = { id, tokenHash, name, ...n, start: n.equity, joinedAt: now, updatedAt: now };
    await store.setJSON("r/" + code, room);
    return json({ ok: true, room: view(room, id) });
  }
  if (action === "update") {
    if (!m) return json({ error: "not_member", message: "你不在这个房间里" }, 404);
    if (ended || now - (m.updatedAt || 0) < 5000) return json({ ok: true, frozen: ended, room: view(room, id) });
    const restarted = m.created && n.created !== m.created;
    const from = Math.max(restarted ? CAPITAL : m.equity, CAPITAL), steps = Math.min(MAX_STEPS, Math.max(1, (now - (m.updatedAt || now)) / STEP));
    if (n.equity > (from + ALLOWANCE) * Math.pow(GROWTH, steps)) return json({ error: "implausible", message: "资产涨得比游戏里可能的还快，这次没有计入" }, 400);
    // restarted the game while in the room: keep the result so far
    if (restarted) m.start = n.equity - (m.equity - m.start);
    Object.assign(m, { name, equity: n.equity, created: n.created, lv: n.lv, rb: n.rb, updatedAt: now });
    await store.setJSON("r/" + code, room);
    return json({ ok: true, room: view(room, id) });
  }
  return json({ error: "bad_action" }, 400);
};

export const config = { path: "/api/room" };
