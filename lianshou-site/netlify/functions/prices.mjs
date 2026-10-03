// 练手交易所 · 行情中转（Netlify Function）
//
// 给连不上海外交易所的玩家（比如中国大陆）用：Netlify 的服务器在海外，
// 它去交易所取价格，再交给玩家的浏览器。
//
// GET /api/prices          → 最新价格（CDN 缓存 20 秒，所有玩家共用一份）
// GET /api/prices/history  → 最新价格 + 最近 6 小时的 1 分钟 K 线（CDN 缓存 60 秒）
//
// 数据源：Kraken 公开接口，失败时改用 Coinbase。
const KRAKEN = { BTC: "XBTUSD", ETH: "ETHUSD", DOGE: "XDGUSD", PEPE: "PEPEUSD", WIF: "WIFUSD" };
const COINBASE = { BTC: "BTC-USD", ETH: "ETH-USD", DOGE: "DOGE-USD", PEPE: "PEPE-USD", WIF: "WIF-USD" };
const COINS = Object.keys(KRAKEN);
const TICK_TTL = 20, HIST_TTL = 60, BARS = 360;

const json = (data, ttl, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=0, must-revalidate",
    ...(ttl ? { "netlify-cdn-cache-control": `public, durable, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` }
            : { "netlify-cdn-cache-control": "no-store" }),
  },
});

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { "user-agent": "lianshou-exchange/1.0" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
const num = (v) => { const n = Number(v); if (!(n > 0) || !isFinite(n)) throw new Error("bad number"); return n; };
function krakenKey(result, coin) {
  const want = { BTC: /XBT|BTC/, ETH: /ETH/, DOGE: /XDG|DOGE/, PEPE: /PEPE/, WIF: /WIF/ }[coin];
  return Object.keys(result).find((k) => k !== "last" && want.test(k));
}

async function krakenTicker() {
  const j = await getJSON("https://api.kraken.com/0/public/Ticker?pair=" + COINS.map((c) => KRAKEN[c]).join(","));
  if (j.error && j.error.length) throw new Error(j.error.join(","));
  const out = {};
  for (const c of COINS) {
    const d = j.result[krakenKey(j.result, c)];
    out[c] = { last: num(d.c[0]), ref: num(d.o) };
  }
  return out;
}
async function krakenBars(coin) {
  const since = Math.floor(Date.now() / 1000) - BARS * 60;
  const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${KRAKEN[coin]}&interval=1&since=${since}`);
  if (j.error && j.error.length) throw new Error(j.error.join(","));
  const rows = j.result[krakenKey(j.result, coin)] || [];
  return rows.slice(-BARS).map((r) => [Number(r[0]), +r[1], +r[2], +r[3], +r[4]]);
}
async function coinbaseTicker() {
  const out = {};
  await Promise.all(COINS.map(async (c) => {
    const s = await getJSON(`https://api.exchange.coinbase.com/products/${COINBASE[c]}/stats`);
    out[c] = { last: num(s.last), ref: num(s.open) };
  }));
  return out;
}
async function coinbaseBars(coin) {
  const rows = await getJSON(`https://api.exchange.coinbase.com/products/${COINBASE[coin]}/candles?granularity=60`);
  return rows.map((r) => [Number(r[0]), +r[3], +r[2], +r[1], +r[4]]).sort((a, b) => a[0] - b[0]).slice(-BARS);
}

async function ticker() {
  try { return { src: "Kraken", coins: await krakenTicker() }; }
  catch (e) { return { src: "Coinbase", coins: await coinbaseTicker() }; }
}
async function history() {
  const t = await ticker();
  const barsFn = t.src === "Kraken" ? krakenBars : coinbaseBars;
  await Promise.all(COINS.map(async (c) => {
    try { t.coins[c].bars = await barsFn(c); } catch (e) { t.coins[c].bars = []; }
  }));
  return t;
}

// a warm function instance also keeps a short copy, so bursts never hit the exchange twice
const mem = { tick: null, tickAt: 0, hist: null, histAt: 0 };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
  const wantHistory = new URL(req.url).pathname.replace(/\/+$/, "").endsWith("/history");
  try {
    const now = Date.now();
    if (wantHistory) {
      if (!mem.hist || now - mem.histAt > (HIST_TTL - 10) * 1000) { mem.hist = { ...(await history()), t: Date.now() }; mem.histAt = Date.now(); }
      return json(mem.hist, HIST_TTL);
    }
    if (!mem.tick || now - mem.tickAt > (TICK_TTL - 5) * 1000) { mem.tick = { ...(await ticker()), t: Date.now() }; mem.tickAt = Date.now(); }
    return json(mem.tick, TICK_TTL);
  } catch (e) {
    return json({ error: "upstream", message: "交易所暂时连不上" }, 0, 502);
  }
};

export const config = { path: ["/api/prices", "/api/prices/history"] };
