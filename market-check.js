// Bybit market health checker. Read-only, public API, no dependencies. Node 18+.
// Run once:      node market-check.js
// Run on loop:   INTERVAL_MIN=15 node market-check.js
// Telegram:      TG_TOKEN=xxx TG_CHAT=123 (alerts only when the verdict changes)
// Dashboard:     PORT=3000 serves the dashboard at / and JSON at /api
//                (refreshes every 5 min unless INTERVAL_MIN is set)

const http = require("http");

const API = "https://api.bybit.com";
const TOP_N = +process.env.TOP_N || 30;
const { TG_TOKEN, TG_CHAT, PORT } = process.env;
const INTERVAL_MIN = +process.env.INTERVAL_MIN || (PORT ? 5 : 0);

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
  const coins = tickers.map((t, i) => ({
    symbol: t.symbol,
    price: +t.lastPrice,
    chg24: +((+t.price24hPcnt || 0) * 100).toFixed(2),
    fundingPct: +((+t.fundingRate || 0) * 100).toFixed(4),
    aboveEma50: above[i],
  }));
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
    coins,
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
const history = [];

async function run() {
  try {
    latest = await check();
    console.log(format(latest) + "\n");
    if (latest.verdict !== lastVerdict) {
      history.unshift({ time: latest.time, verdict: latest.verdict, score: latest.score });
      if (history.length > 20) history.pop();
      await telegram(format(latest));
      lastVerdict = latest.verdict;
    }
  } catch (e) {
    console.error("Check failed:", e.message);
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bybit Market Check</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#262d36;--text:#e6edf3;--mute:#8b949e;--long:#2ea043;--short:#f85149;--mixed:#d29922;--bad:#6e7681}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,sans-serif;padding:16px;max-width:900px;margin:auto}
h1{font-size:15px;color:var(--mute);font-weight:500;margin:0 0 12px;display:flex;justify-content:space-between}
.hero{border-radius:10px;padding:20px;text-align:center;border:1px solid var(--line);background:var(--card)}
.hero .v{font-size:26px;font-weight:700}
.hero .s{color:var(--mute);margin-top:6px}
.long{border-color:var(--long);color:var(--long)}.short{border-color:var(--short);color:var(--short)}
.mixed{border-color:var(--mixed);color:var(--mixed)}.bad{border-color:var(--bad);color:var(--mute)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.card .l{color:var(--mute);font-size:12px}.card .n{font-size:18px;font-weight:600;margin-top:4px}
.up{color:var(--long)}.down{color:var(--short)}
.flags{margin:0 0 12px;display:flex;gap:8px;flex-wrap:wrap}
.flag{background:#3b2f10;color:var(--mixed);border-radius:6px;padding:4px 8px;font-size:12px}
h2{font-size:13px;color:var(--mute);font-weight:500;margin:18px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--line)}
th:first-child,td:first-child{text-align:left}
th{color:var(--mute);font-weight:500;font-size:12px}
.wrap{overflow-x:auto}
.hist div{padding:6px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:10px}
.hist span:last-child{color:var(--mute);white-space:nowrap}
</style></head><body>
<h1><span>Bybit Market Check</span><span id="time">loading</span></h1>
<div id="hero" class="hero bad"><div class="v" id="verdict">Loading</div><div class="s" id="score"></div></div>
<div class="grid" id="metrics"></div>
<div class="flags" id="flags"></div>
<h2>Top coins by volume</h2>
<div class="wrap"><table><thead><tr><th>Symbol</th><th>Price</th><th>24h</th><th>1h EMA50</th><th>Funding</th></tr></thead><tbody id="coins"></tbody></table></div>
<h2>Verdict history</h2>
<div class="hist" id="hist"></div>
<script>
var $=function(i){return document.getElementById(i)};
function cls(v){return v.indexOf("GOOD for LONGS")===0?"long":v.indexOf("GOOD for SHORTS")===0?"short":v.indexOf("NOT")===0?"bad":"mixed"}
function trendCls(t){return t==="up"?"up":t==="down"?"down":""}
function card(l,n,c){return '<div class="card"><div class="l">'+l+'</div><div class="n '+(c||"")+'">'+n+'</div></div>'}
function load(){
  fetch("/api").then(function(r){return r.json()}).then(function(d){
    var r=d.latest;
    if(!r){$("verdict").textContent="Starting, first check running";return}
    $("hero").className="hero "+cls(r.verdict);
    $("verdict").textContent=r.verdict;
    $("score").textContent="Score "+r.score+" of 5 (negative means bearish)";
    $("time").textContent="Updated "+new Date(r.time).toLocaleTimeString();
    $("metrics").innerHTML=
      card("BTC 4h trend",r.btc4hTrend,trendCls(r.btc4hTrend))+
      card("BTC 1h trend",r.btc1hTrend,trendCls(r.btc1hTrend))+
      card("Above 1h EMA50",r.breadthAboveEma50Pct+"%",r.breadthAboveEma50Pct>=55?"up":r.breadthAboveEma50Pct<=45?"down":"")+
      card("Green on 24h",r.green24hPct+"%")+
      card("BTC efficiency",r.btcEfficiency,r.btcEfficiency<0.25?"down":"")+
      card("BTC ATR",r.btcAtrPct+"%")+
      card("Avg funding",r.avgFundingPct+"%");
    $("flags").innerHTML=r.flags.map(function(f){return '<span class="flag">'+f+'</span>'}).join("");
    $("coins").innerHTML=r.coins.map(function(c){
      var e=c.aboveEma50===null?"n/a":c.aboveEma50?"above":"below";
      return '<tr><td>'+c.symbol.replace("USDT","")+'</td><td>'+c.price+'</td><td class="'+(c.chg24>=0?"up":"down")+'">'+c.chg24+'%</td><td class="'+(e==="above"?"up":e==="below"?"down":"")+'">'+e+'</td><td>'+c.fundingPct+'%</td></tr>';
    }).join("");
    $("hist").innerHTML=d.history.map(function(h){
      return '<div><span>'+h.verdict+' ('+h.score+')</span><span>'+new Date(h.time).toLocaleString()+'</span></div>';
    }).join("");
  }).catch(function(){$("time").textContent="connection lost"});
}
load();setInterval(load,30000);
</script></body></html>`;

if (PORT) {
  http
    .createServer((req, res) => {
      if (req.url === "/api") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ latest, history }));
      } else if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(PAGE);
      }
    })
    .listen(PORT, () => console.log(`Dashboard on port ${PORT}`));
}

run();
if (INTERVAL_MIN > 0) setInterval(run, INTERVAL_MIN * 60 * 1000);
