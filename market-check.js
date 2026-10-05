// Bybit market health checker. Read-only, public API, no dependencies. Node 18+.
// Run once:      node market-check.js
// Run on loop:   INTERVAL_MIN=15 node market-check.js
// Telegram:      TG_TOKEN=xxx TG_CHAT=123 (alerts only when the verdict changes)
// Web (Render):  PORT=3000 serves the latest report as JSON at /

const http = require("http");

const API = "https://api.bybit.com";
const TOP_N = +process.env.TOP_N || 30;
const INTERVAL_MIN = +process.env.INTERVAL_MIN || 0;
const { TG_TOKEN, TG_CHAT, PORT } = process.env;

async function get(path) {
  const res = await fetch(API + path);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(json.retMsg);
  return json.result;
}

// Returns closed candles, oldest first. Drops the live candle.
async function klines(symbol, interval, limit = 120) {
  const r = await get(
    `/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  return r.list
    .slice()
    .reverse()
    .slice(0, -1)
    .map((k) => ({ h: +k[2], l: +k[3], c: +k[4] }));
}

function ema(values, period) {
  const k = 2 / (period + 1);
  return values.reduce((prev, v, i) => (i === 0 ? v : v * k + prev * (1 - k)));
}

// 1 = uptrend, -1 = downtrend, 0 = no clear trend
function trend(candles) {
  const closes = candles.map((c) => c.c);
  const price = closes[closes.length - 1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  if (price > e20 && e20 > e50) return 1;
  if (price < e20 && e20 < e50) return -1;
  return 0;
}

// Near 1 = clean directional move. Near 0 = chop.
function efficiency(candles, n = 24) {
  const c = candles.slice(-(n + 1)).map((x) => x.c);
  let path = 0;
  for (let i = 1; i < c.length; i++) path += Math.abs(c[i] - c[i - 1]);
  return path === 0 ? 0 : Math.abs(c[c.length - 1] - c[0]) / path;
}

// Average true range as % of price
function atrPct(candles, n = 14) {
  const s = candles.slice(-(n + 1));
  let sum = 0;
  for (let i = 1; i < s.length; i++) {
    const tr = Math.max(
      s[i].h - s[i].l,
      Math.abs(s[i].h - s[i - 1].c),
      Math.abs(s[i].l - s[i - 1].c)
    );
    sum += tr;
  }
  return (sum / n / s[s.length - 1].c) * 100;
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

async function check() {
  const tickers = (await get("/v5/market/tickers?category=linear")).list
    .filter((t) => t.symbol.endsWith("USDT"))
    .sort((a, b) => +b.turnover24h - +a.turnover24h)
    .slice(0, TOP_N);

  const [btc4h, btc1h] = await Promise.all([
    klines("BTCUSDT", "240"),
    klines("BTCUSDT", "60"),
  ]);
  const t4 = trend(btc4h);
  const t1 = trend(btc1h);
  const er = efficiency(btc1h);
  const atr = atrPct(btc1h);

  const above = await inBatches(tickers, 5, async (t) => {
    try {
      const c = (await klines(t.symbol, "60")).map((x) => x.c);
      return c[c.length - 1] > ema(c, 50);
    } catch {
      return null;
    }
  });
  const valid = above.filter((x) => x !== null);
  const breadth = (valid.filter(Boolean).length / valid.length) * 100;

  const funding =
    tickers.reduce((s, t) => s + (+t.fundingRate || 0), 0) / tickers.length;
  const green24h =
    (tickers.filter((t) => +t.price24hPcnt > 0).length / tickers.length) * 100;

  let score = t4 * 2 + t1;
  if (breadth >= 65) score += 2;
  else if (breadth >= 55) score += 1;
  else if (breadth <= 35) score -= 2;
  else if (breadth <= 45) score -= 1;

  const flags = [];
  if (er < 0.25) flags.push("BTC is choppy");
  if (atr < 0.3) flags.push("volatility too low");
  if (atr > 2) flags.push("volatility too high");
  if (funding > 0.0003) flags.push("longs crowded (high funding)");
  if (funding < -0.0003) flags.push("shorts crowded (negative funding)");

  let verdict;
  if (flags.includes("BTC is choppy") || flags.includes("volatility too low"))
    verdict = "NOT GOOD: no clean moves, stay out";
  else if (score >= 3) verdict = "GOOD for LONGS";
  else if (score <= -3) verdict = "GOOD for SHORTS";
  else verdict = "MIXED: wait for a clearer market";

  return {
    time: new Date().toISOString(),
    verdict,
    score,
    btc4hTrend: ["down", "none", "up"][t4 + 1],
    btc1hTrend: ["down", "none", "up"][t1 + 1],
    breadthAboveEma50Pct: +breadth.toFixed(0),
    green24hPct: +green24h.toFixed(0),
    btcEfficiency: +er.toFixed(2),
    btcAtrPct: +atr.toFixed(2),
    avgFundingPct: +(funding * 100).toFixed(4),
    flags,
  };
}

function format(r) {
  return [
    `Bybit market: ${r.verdict}`,
    `Score: ${r.score} (range -5 to 5)`,
    `BTC 4h: ${r.btc4hTrend} | BTC 1h: ${r.btc1hTrend}`,
    `Top ${TOP_N} above 1h EMA50: ${r.breadthAboveEma50Pct}%`,
    `Green on 24h: ${r.green24hPct}%`,
    `BTC efficiency: ${r.btcEfficiency} | ATR: ${r.btcAtrPct}%`,
    `Avg funding: ${r.avgFundingPct}%`,
    r.flags.length ? `Flags: ${r.flags.join(", ")}` : "Flags: none",
  ].join("\n");
}

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  });
}

let latest = null;
let lastVerdict = null;

async function run() {
  try {
    latest = await check();
    console.log(format(latest) + "\n");
    if (latest.verdict !== lastVerdict) {
      await telegram(format(latest));
      lastVerdict = latest.verdict;
    }
  } catch (e) {
    console.error("Check failed:", e.message);
  }
}

if (PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(latest || { status: "starting" }));
    })
    .listen(PORT, () => console.log(`Serving on ${PORT}`));
}

run();
if (INTERVAL_MIN > 0) setInterval(run, INTERVAL_MIN * 60 * 1000);
