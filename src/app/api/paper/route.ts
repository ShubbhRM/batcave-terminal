/**
 * /api/paper — Forward paper-trading engine.
 *
 * State is persisted to paper-trading.json in the project root so it
 * survives server restarts and accumulates across multiple market sessions.
 *
 * GET  /api/paper          → returns current session state (or null)
 * POST /api/paper  { action: 'init',   capital, assets }  → start new session
 * POST /api/paper  { action: 'update' }                   → run inference & update
 * POST /api/paper  { action: 'reset'  }                   → clear session
 */

import { NextResponse } from 'next/server';
import * as ort from 'onnxruntime-web';
import path from 'path';
import fs from 'fs';

export const runtime    = 'nodejs';
export const maxDuration = 30;

// WASM backend — no native .so needed
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths  = path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist') + '/';

// ─── ONNX singleton ───────────────────────────────────────────────────────────
let _session: ort.InferenceSession | null = null;
async function getSession(): Promise<ort.InferenceSession> {
  if (!_session) {
    const p = path.join(process.cwd(), 'public', 'hierarchical_moderator.onnx');
    _session = await ort.InferenceSession.create(p, { graphOptimizationLevel: 'disabled' });
  }
  return _session;
}

const LSTM_HIDDEN  = 256;
const LOOKBACK     = 60;

// On Vercel, process.cwd() is read-only; /tmp is writable per function instance.
// Locally we use the project root so state survives restarts.
const STATE_FILE = process.env.VERCEL
  ? '/tmp/paper-trading.json'
  : path.join(process.cwd(), 'paper-trading.json');

// ─── State types ──────────────────────────────────────────────────────────────
interface PaperTrade {
  date:           string;
  asset:          string;
  action:         'BUY' | 'SELL' | 'REBALANCE';
  shares:         number;
  price:          number;
  signal:         number;
  portfolioValue: number;
}

interface PaperSnapshot {
  date:           string;
  portfolioValue: number;
  benchmarkValue: number;
  allocation:     Record<string, number>;
  weights:        Record<string, { momentum: number; meanReversion: number; volume: number }>;
}

interface PaperState {
  active:          boolean;
  startDate:       string;
  lastUpdate:      string | null;
  startCapital:    number;
  assets:          string[];
  holdings:        Record<string, { shares: number }>;
  benchmarkShares: number;             // SPY shares for B&H comparison
  prevSignals:     Record<string, number>;
  lstmH:           Record<string, number[]>;  // serialised Float32Array
  lstmC:           Record<string, number[]>;
  trades:          PaperTrade[];
  snapshots:       PaperSnapshot[];
}

// ─── State I/O ────────────────────────────────────────────────────────────────
function readState(): PaperState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}

function writeState(s: PaperState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ─── LSTM tensor helpers ──────────────────────────────────────────────────────
function zeroState(): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(LSTM_HIDDEN), [1, 1, LSTM_HIDDEN]);
}

function tensorFromArray(arr: number[]): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(arr), [1, 1, LSTM_HIDDEN]);
}

function tensorToArray(t: ort.Tensor): number[] {
  return Array.from(t.data as Float32Array);
}

// ─── OHLCV bar type ───────────────────────────────────────────────────────────
interface Bar { date: string; close: number; volume: number }

async function fetchBars(symbol: string): Promise<Bar[] | null> {
  // Pull 90 calendar days to ensure we always have 60+ trading days
  const end   = Math.floor(Date.now() / 1000);
  const start = end - 90 * 24 * 3600;
  const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${start}&period2=${end}`;
  try {
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const r    = json.chart?.result?.[0];
    if (!r?.timestamp) return null;
    const q = r.indicators.quote[0];
    return r.timestamp
      .map((ts: number, i: number) => ({
        date:   new Date(ts * 1000).toISOString(),
        close:  q.close[i],
        volume: q.volume[i],
      }))
      .filter((b: Bar) => b.close != null && b.volume != null);
  } catch { return null; }
}

// ─── Feature extraction (mirrors training env) ────────────────────────────────
function extractFeatures(history: Bar[]): number[] {
  const closes  = history.map(b => b.close);
  const volumes = history.map(b => b.volume);
  const cur     = closes[closes.length - 1];

  const sma = (arr: number[], n: number) => arr.slice(-n).reduce((a, b) => a + b, 0) / n;
  const sma20 = sma(closes, Math.min(20, closes.length));
  const sma50 = sma(closes, Math.min(50, closes.length));
  const mom_sig  = Math.max(-1, Math.min(1, ((sma20 - sma50) / cur) * 20));
  const mom_conf = Math.min(Math.abs(mom_sig), 1);

  let gains = 0, losses = 0;
  const rsiN = Math.min(14, closes.length - 1);
  for (let i = closes.length - rsiN; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs      = losses === 0 ? 100 : (gains / rsiN) / (losses / rsiN);
  const rsi     = 100 - 100 / (1 + rs);
  const rsi_sig = Math.max(-1, Math.min(1, (50 - rsi) / 20));
  const sl20    = closes.slice(-Math.min(20, closes.length));
  const m20     = sl20.reduce((a, b) => a + b, 0) / sl20.length;
  const s20     = Math.sqrt(sl20.reduce((a, b) => a + (b - m20) ** 2, 0) / sl20.length) || 1;
  const z_sig   = Math.max(-1, Math.min(1, -(cur - m20) / s20 / 2));
  const mr_sig  = (rsi_sig + z_sig) / 2;
  const mr_conf = Math.min(Math.abs(mr_sig) * 1.5, 1);

  let obv = 0;
  const obvS: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    obv += closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0;
    obvS.push(obv);
  }
  const os   = obvS.slice(-20);
  const om   = os.reduce((a, b) => a + b, 0) / os.length;
  const ostd = Math.sqrt(os.reduce((a, b) => a + (b - om) ** 2, 0) / os.length) || 1;
  const vol_sig  = Math.max(-1, Math.min(1, Math.tanh(obv / ostd)));
  const vol_conf = Math.min(Math.abs(vol_sig) * 1.5, 1);

  const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const stdAll  = Math.sqrt(returns.reduce((a, b) => a + b * b, 0) / (returns.length || 1));
  const vol     = stdAll * Math.sqrt(252);
  const trend   = Math.max(-1, Math.min(1, (cur - closes[0]) / closes[0] * 5));

  return [mom_sig, mom_conf, mr_sig, mr_conf, vol_sig, vol_conf, vol * 10, trend, 0, 0];
}

function softmax(logits: number[]): number[] {
  const max  = Math.max(...logits);
  const exps = logits.map(x => Math.exp(x - max));
  const sum  = exps.reduce((a, b) => a + b, 0);
  return exps.map(x => x / sum);
}

function signal(w: number[], f: number[]): number {
  return w[0] * f[0] * f[1] + w[1] * f[2] * f[3] + w[2] * f[4] * f[5];
}

// ─── GET ──────────────────────────────────────────────────────────────────────
export async function GET() {
  const state = readState();
  if (!state) return NextResponse.json({ active: false });

  // Enrich with live portfolio value for display
  let portfolioValue = 0;
  const livePrices: Record<string, number> = {};
  for (const [sym, h] of Object.entries(state.holdings)) {
    const bars = await fetchBars(sym);
    if (bars && bars.length > 0) {
      const price = bars[bars.length - 1].close;
      livePrices[sym] = price;
      portfolioValue += h.shares * price;
    }
  }

  const pnl    = portfolioValue - state.startCapital;
  const pnlPct = (pnl / state.startCapital) * 100;

  // SPY benchmark
  let benchmarkValue = state.startCapital;
  if (state.benchmarkShares > 0) {
    const spyBars = await fetchBars('SPY');
    if (spyBars && spyBars.length > 0) {
      benchmarkValue = state.benchmarkShares * spyBars[spyBars.length - 1].close;
    }
  }
  const benchmarkReturn = ((benchmarkValue - state.startCapital) / state.startCapital) * 100;
  const alpha = pnlPct - benchmarkReturn;

  // Max drawdown from snapshots
  let peakVal = state.startCapital;
  let minVal  = state.startCapital;
  for (const s of state.snapshots) {
    peakVal = Math.max(peakVal, s.portfolioValue);
    minVal  = Math.min(minVal, s.portfolioValue);
  }
  peakVal = Math.max(peakVal, portfolioValue);
  minVal  = Math.min(minVal, portfolioValue);
  const maxDrawdown = peakVal > 0 ? ((peakVal - minVal) / peakVal) * 100 : 0;

  const daysSince = Math.floor(
    (Date.now() - new Date(state.startDate).getTime()) / (1000 * 60 * 60 * 24)
  );

  return NextResponse.json({
    ...state,
    live: {
      portfolioValue: parseFloat(portfolioValue.toFixed(2)),
      pnl:            parseFloat(pnl.toFixed(2)),
      pnlPct:         parseFloat(pnlPct.toFixed(3)),
      benchmarkValue: parseFloat(benchmarkValue.toFixed(2)),
      benchmarkReturn:parseFloat(benchmarkReturn.toFixed(3)),
      alpha:          parseFloat(alpha.toFixed(3)),
      maxDrawdown:    parseFloat(maxDrawdown.toFixed(2)),
      daysSince,
      livePrices,
    },
    // Strip LSTM blobs from the response (they're internal state, not UI data)
    lstmH: undefined,
    lstmC: undefined,
  });
}

// ─── POST ─────────────────────────────────────────────────────────────────────
export async function POST(request: Request) {
  const body = await request.json();

  // ── RESET ──────────────────────────────────────────────────────────────────
  if (body.action === 'reset') {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    return NextResponse.json({ ok: true, message: 'Session cleared.' });
  }

  // ── INIT ───────────────────────────────────────────────────────────────────
  if (body.action === 'init') {
    const capital: number   = parseFloat(body.capital ?? 10000);
    const assets: string[]  = (body.assets as string[]).slice(0, 5);

    // Fetch current prices to establish initial positions
    const initialHoldings: Record<string, { shares: number }> = {};
    const perAsset = capital / assets.length;
    let benchmarkShares = 0;

    const fetchAll = await Promise.all(
      [...new Set([...assets, 'SPY'])].map(sym => fetchBars(sym).then(b => [sym, b] as const))
    );
    const barMap: Record<string, Bar[]> = {};
    for (const [sym, bars] of fetchAll) {
      if (bars && bars.length > LOOKBACK) barMap[sym] = bars;
    }

    for (const sym of assets) {
      if (!barMap[sym]) continue;
      const price = barMap[sym][barMap[sym].length - 1].close;
      initialHoldings[sym] = { shares: perAsset / price };
    }

    if (barMap['SPY']) {
      const spyPrice = barMap['SPY'][barMap['SPY'].length - 1].close;
      benchmarkShares = capital / spyPrice;
    }

    const state: PaperState = {
      active:          true,
      startDate:       new Date().toISOString(),
      lastUpdate:      null,
      startCapital:    capital,
      assets:          assets.filter(s => !!barMap[s]),
      holdings:        initialHoldings,
      benchmarkShares,
      prevSignals:     {},
      lstmH:           {},
      lstmC:           {},
      trades:          [],
      snapshots:       [],
    };

    writeState(state);
    return NextResponse.json({ ok: true, message: 'Session initialised.', assets: state.assets });
  }

  // ── UPDATE ─────────────────────────────────────────────────────────────────
  if (body.action === 'update') {
    let state = readState();
    if (!state || !state.active) {
      return NextResponse.json({ error: 'No active session. Initialise one first.' }, { status: 400 });
    }

    const session = await getSession();

    // Fetch fresh bars for each asset
    const barMap: Record<string, Bar[]> = {};
    await Promise.all(state.assets.map(async sym => {
      const bars = await fetchBars(sym);
      if (bars && bars.length >= LOOKBACK) barMap[sym] = bars;
    }));

    let totalVal = 0;
    const allocs: Record<string, number> = {};
    const newWeights: Record<string, { momentum: number; meanReversion: number; volume: number }> = {};
    const newTrades: PaperTrade[] = [];

    for (const sym of state.assets) {
      const bars = barMap[sym];
      if (!bars) continue;

      const price = bars[bars.length - 1].close;
      allocs[sym] = (state.holdings[sym]?.shares ?? 0) * price;
      totalVal   += allocs[sym];
    }

    // Per-asset LSTM inference — restore saved state
    for (const sym of state.assets) {
      const bars = barMap[sym];
      if (!bars) continue;

      const window = bars.slice(-LOOKBACK);
      const feats  = extractFeatures(window);
      const obs    = new ort.Tensor('float32', Float32Array.from(feats), [1, 10]);

      const h = state.lstmH[sym] ? tensorFromArray(state.lstmH[sym]) : zeroState();
      const c = state.lstmC[sym] ? tensorFromArray(state.lstmC[sym]) : zeroState();

      const result  = await session.run({ observation: obs, h_in: h, c_in: c });

      // Persist updated LSTM state for next call
      state.lstmH[sym] = tensorToArray(result.h_out as ort.Tensor);
      state.lstmC[sym] = tensorToArray(result.c_out as ort.Tensor);

      const logits  = Array.from(result.expert_weights.data as Float32Array);
      const weights = softmax(logits);
      const sig     = signal(weights, feats);
      const prev    = state.prevSignals[sym] ?? 0;
      const change  = Math.abs(sig - prev);

      newWeights[sym] = {
        momentum:      parseFloat(weights[0].toFixed(4)),
        meanReversion: parseFloat(weights[1].toFixed(4)),
        volume:        parseFloat(weights[2].toFixed(4)),
      };

      // Execute trade if signal shifted meaningfully
      if (change > 0.05) {
        const price  = bars[bars.length - 1].close;
        const action: PaperTrade['action'] =
          sig > 0.1 ? 'BUY' : sig < -0.1 ? 'SELL' : 'REBALANCE';
        const tradeVal = Math.abs(sig) * (allocs[sym] || state.startCapital / state.assets.length) * 0.1;
        const shares   = tradeVal / price;

        if (action === 'BUY') {
          state.holdings[sym] = { shares: (state.holdings[sym]?.shares ?? 0) + shares };
        } else if (action === 'SELL') {
          state.holdings[sym] = { shares: Math.max(0, (state.holdings[sym]?.shares ?? 0) - shares) };
        }

        newTrades.push({
          date:           new Date().toISOString(),
          asset:          sym,
          action,
          shares:         parseFloat(shares.toFixed(4)),
          price:          parseFloat(price.toFixed(2)),
          signal:         parseFloat(sig.toFixed(4)),
          portfolioValue: parseFloat(totalVal.toFixed(2)),
        });
      }

      state.prevSignals[sym] = sig;
    }

    // Recalculate portfolio value post-trades
    let finalVal = 0;
    const finalAlloc: Record<string, number> = {};
    for (const sym of state.assets) {
      const bars = barMap[sym];
      if (!bars) continue;
      const price = bars[bars.length - 1].close;
      const val   = (state.holdings[sym]?.shares ?? 0) * price;
      finalAlloc[sym] = parseFloat(val.toFixed(2));
      finalVal += val;
    }

    // SPY benchmark
    const spyBars    = await fetchBars('SPY');
    const benchValue = spyBars && spyBars.length > 0
      ? state.benchmarkShares * spyBars[spyBars.length - 1].close
      : state.startCapital;

    // Record snapshot
    state.snapshots.push({
      date:           new Date().toISOString(),
      portfolioValue: parseFloat(finalVal.toFixed(2)),
      benchmarkValue: parseFloat(benchValue.toFixed(2)),
      allocation:     finalAlloc,
      weights:        newWeights,
    });

    state.trades     = [...state.trades, ...newTrades];
    state.lastUpdate = new Date().toISOString();

    writeState(state);

    return NextResponse.json({
      ok:             true,
      trades:         newTrades,
      portfolioValue: parseFloat(finalVal.toFixed(2)),
      benchmarkValue: parseFloat(benchValue.toFixed(2)),
      pnlPct:         parseFloat(((finalVal - state.startCapital) / state.startCapital * 100).toFixed(3)),
      snapshotCount:  state.snapshots.length,
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
