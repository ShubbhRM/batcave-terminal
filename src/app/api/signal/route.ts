/**
 * GET /api/signal?symbol=SPY
 *
 * Server-side ONNX inference using onnxruntime-web (WASM backend).
 * Returns expert weights + live price for the live dashboard.
 */

import { NextResponse } from 'next/server';
import * as ort from 'onnxruntime-web';
import path from 'path';

export const runtime     = 'nodejs';
export const maxDuration = 30;

// WASM backend — no native .so needed
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths  = path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist') + '/';

const LSTM_HIDDEN = 256;
const LOOKBACK    = 60;

// ─── ONNX singleton ───────────────────────────────────────────────────────────
let _session: ort.InferenceSession | null = null;
async function getSession(): Promise<ort.InferenceSession> {
  if (!_session) {
    const p = path.join(process.cwd(), 'public', 'hierarchical_moderator.onnx');
    _session = await ort.InferenceSession.create(p);
  }
  return _session;
}

// ─── Market data ──────────────────────────────────────────────────────────────
interface Bar { close: number; volume: number }

async function fetchBars(symbol: string): Promise<Bar[] | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
  try {
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const r    = json.chart?.result?.[0];
    if (!r?.timestamp) return null;
    const q = r.indicators.quote[0];
    return r.timestamp
      .map((ts: number, i: number) => ({ date: ts, close: q.close[i], volume: q.volume[i] }))
      .filter((b: Bar & { date: number }) => b.close != null && b.volume != null);
  } catch { return null; }
}

async function fetchLivePrice(symbol: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d`;
  try {
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const r    = json.chart?.result?.[0];
    const q    = r?.indicators?.quote?.[0];
    const cls  = (q?.close ?? []).filter((c: number | null) => c !== null);
    return cls.length > 0 ? cls[cls.length - 1] : null;
  } catch { return null; }
}

// ─── Feature extraction ───────────────────────────────────────────────────────
function extractFeatures(bars: Bar[]): number[] {
  const closes  = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const cur     = closes[closes.length - 1];

  const sma = (arr: number[], n: number) =>
    arr.slice(-n).reduce((a, b) => a + b, 0) / Math.min(n, arr.length);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
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

// ─── GET handler ──────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get('symbol') || 'SPY').toUpperCase();

  try {
    const [bars, livePrice] = await Promise.all([
      fetchBars(symbol),
      fetchLivePrice(symbol),
    ]);

    if (!bars || bars.length < LOOKBACK) {
      return NextResponse.json({ error: `Not enough data for ${symbol}` }, { status: 422 });
    }

    const window = bars.slice(-LOOKBACK);
    const feats  = extractFeatures(window);
    const obs    = new ort.Tensor('float32', Float32Array.from(feats), [1, 10]);
    const h      = new ort.Tensor('float32', new Float32Array(LSTM_HIDDEN), [1, 1, LSTM_HIDDEN]);
    const c      = new ort.Tensor('float32', new Float32Array(LSTM_HIDDEN), [1, 1, LSTM_HIDDEN]);

    const session = await getSession();
    const result  = await session.run({ observation: obs, h_in: h, c_in: c });
    const logits  = Array.from(result.expert_weights.data as Float32Array);
    const weights = softmax(logits);

    // Market hours (ET)
    const now    = new Date();
    const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h_est  = estNow.getHours(), m_est = estNow.getMinutes();
    const isWeekday   = estNow.getDay() > 0 && estNow.getDay() < 6;
    const marketOpen  = isWeekday && (h_est > 9 || (h_est === 9 && m_est >= 30)) && h_est < 16;

    const price = livePrice ?? bars[bars.length - 1].close;

    return NextResponse.json({
      symbol,
      price:      parseFloat(price.toFixed(2)),
      marketOpen,
      weights: {
        momentum:      parseFloat(weights[0].toFixed(4)),
        meanReversion: parseFloat(weights[1].toFixed(4)),
        volume:        parseFloat(weights[2].toFixed(4)),
      },
      timestamp: new Date().toISOString(),
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
