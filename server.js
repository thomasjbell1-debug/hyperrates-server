const https = require('https');
const http = require('http');

const TRADFI = new Set([
  'EUR','GBP','JPY','AUD','CAD','CHF','NZD','MXN','BRL','SGD','HKD','KRW','TRY','ZAR','NOK','SEK','DKK','PLN','CZK','HUF',
  'AAPL','AMZN','TSLA','GOOGL','GOOG','MSFT','NVDA','META','NFLX','BABA','AMD','INTC','COIN','MSTR','MARA','RIOT',
  'GOLD','SILVER','XAU','XAG','OIL','CRUDE','WTI','BRENT','NATGAS','GAS',
  'SPX','SPY','QQQ','NDX','DJI','VIX','WHEAT','CORN','SOYBEAN','COFFEE','SUGAR','COTTON',
  'USDT','USDC','BUSD','DAI','FRAX','TUSD','USDP','PYUSD'
]);

function isCrypto(coin) { return !TRADFI.has(coin.toUpperCase()); }
function annualise(r) { return r * 24 * 365; }

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.hyperliquid.xyz',
      path: '/info',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 20000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postWithRetry(body, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await post(body);
    } catch(e) {
      console.log(`Retry ${i+1} for ${body.coin || body.type}: ${e.message}`);
      if (i < attempts - 1) await sleep(1000 * (i + 1));
    }
  }
  throw new Error('All retries failed');
}

async function fetchFullHistory(coin, now) {
  const mid = now - 15 * 86400000;
  const start30 = now - 31 * 86400000;
  const [recent, older] = await Promise.all([
    postWithRetry({ type: 'fundingHistory', coin, startTime: mid, endTime: now }),
    postWithRetry({ type: 'fundingHistory', coin, startTime: start30, endTime: mid })
  ]);
  return [...(Array.isArray(older) ? older : []), ...(Array.isArray(recent) ? recent : [])];
}

function calcAvgs(hist, now) {
  if (!hist.length) return { avg24h: null, avg3d: null, avg7d: null, avg14d: null, avg30d: null };
  const avgs = {};
  for (const [key, hours] of [['avg24h',24],['avg3d',72],['avg7d',168],['avg14d',336],['avg30d',720]]) {
    const cutoff = now - hours * 3600000;
    const recent = hist.filter(h => h.time >= cutoff);
    avgs[key] = recent.length ? annualise(recent.reduce((a,h) => a + parseFloat(h.fundingRate), 0) / recent.length) : null;
  }
  return avgs;
}

let cache = null;
let cacheTime = 0;
let building = false;

async function buildCache() {
  if (building) return;
  building = true;
  console.log('Building cache...');
  try {
    const now = Date.now();
    const [meta, ctxs] = await postWithRetry({ type: 'metaAndAssetCtxs' });
    const MIN_OI = 1_000_000;
    const coins = [];
    meta.universe.forEach((asset, i) => {
      const ctx = ctxs[i];
      const oi = parseFloat(ctx.openInterest) * parseFloat(ctx.markPx);
      if (isCrypto(asset.name) && oi >= MIN_OI) {
        coins.push({
          coin: asset.name, oi,
          current: annualise(parseFloat(ctx.funding)),
          avg24h: null, avg3d: null, avg7d: null, avg14d: null, avg30d: null
        });
      }
    });
    coins.sort((a, b) => b.oi - a.oi);

    // Sequential with retries and small delay between each
    let success = 0, failed = 0;
    for (const row of coins) {
      try {
        const hist = await fetchFullHistory(row.coin, now);
        if (hist.length > 0) {
          Object.assign(row, calcAvgs(hist, now));
          success++;
        } else {
          console.log(`Empty history for ${row.coin}`);
          failed++;
        }
      } catch(e) {
        console.log(`Failed ${row.coin}: ${e.message}`);
        failed++;
      }
      await sleep(100); // Small delay to avoid rate limiting
    }

    cache = { coins, updatedAt: now };
    cacheTime = now;
    console.log(`Cache built — ${coins.length} coins, ${success} with history, ${failed} failed`);
  } catch(e) {
    console.error('Cache build failed:', e.message);
  }
  building = false;
}

buildCache();
setInterval(buildCache, 60 * 60 * 1000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/rates' || req.url === '/') {
    if (!cache) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'Cache building, try again in 2 minutes' }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify(cache));
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      cacheAge: cache ? Math.round((Date.now() - cacheTime) / 60000) + 'm' : 'building',
      coins: cache ? cache.coins.length : 0,
      withAvg24h: cache ? cache.coins.filter(c => c.avg24h !== null).length : 0
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Use /rates' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('HyperRates server running on port', PORT));
