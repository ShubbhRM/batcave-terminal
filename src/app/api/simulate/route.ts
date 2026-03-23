import { NextResponse } from 'next/server';
import * as ort from 'onnxruntime-web';
import path from 'path';

export const runtime     = 'nodejs';
export const maxDuration = 30;

// onnxruntime-web: WASM backend — no native .so needed, works on Vercel
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths  = path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist') + '/';

// ─── ONNX session singleton ───────────────────────────────────────────────────
let _session: ort.InferenceSession | null = null;

async function getOnnxSession(): Promise<ort.InferenceSession> {
  if (!_session) {
    const modelPath = path.join(process.cwd(), 'public', 'hierarchical_moderator.onnx');
    _session = await ort.InferenceSession.create(modelPath, { graphOptimizationLevel: 'disabled' });
  }
  return _session;
}

const LSTM_HIDDEN = 256;

// ─── Types ────────────────────────────────────────────────────────────────────
interface OHLCVBar {
  date:   string;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

interface TradeEvent {
  timestamp:      string;
  action:         'BUY' | 'SELL' | 'HOLD' | 'REBALANCE';
  asset:          string;
  shares:         number;
  price:          number;
  portfolioValue: number;
  pnl:            number;
  pnlPct:         number;
  allocation:     Record<string, number>;
  weights:        { momentum: number; meanReversion: number; volume: number };
}

interface TimelinePoint {
  timestamp:      string;
  portfolioValue: number;
  benchmarkValue: number;
  dominant:       'momentum' | 'meanReversion' | 'volume';
  weights:        { momentum: number; meanReversion: number; volume: number };
}

// ─── Feature Extraction (mirrors technical_moderator.py exactly) ─────────────
function extractFeatures(history: OHLCVBar[], annFactor: number): number[] {
  const closes  = history.map(b => b.close);
  const volumes = history.map(b => b.volume);
  const cur     = closes[closes.length - 1];

  // 1. Momentum (SMA crossover)
  const sma      = (arr: number[], n: number) => arr.slice(-n).reduce((a, b) => a + b, 0) / n;
  const sma20    = sma(closes, Math.min(20, closes.length));
  const sma50    = sma(closes, Math.min(50, closes.length));
  const mom_sig  = Math.max(-1, Math.min(1, ((sma20 - sma50) / cur) * 20));
  const mom_conf = Math.min(Math.abs(mom_sig), 1.0);

  // 2. Mean Reversion (RSI + Z-score)
  let gains = 0, losses = 0;
  const rsiLookback = Math.min(14, closes.length - 1);
  for (let i = closes.length - rsiLookback; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs      = losses === 0 ? 100 : (gains / rsiLookback) / (losses / rsiLookback);
  const rsi     = 100 - 100 / (1 + rs);
  const rsi_sig = Math.max(-1, Math.min(1, (50 - rsi) / 20));
  const slice20 = closes.slice(-Math.min(20, closes.length));
  const mean20  = slice20.reduce((a, b) => a + b, 0) / slice20.length;
  const std20   = Math.sqrt(slice20.reduce((a, b) => a + (b - mean20) ** 2, 0) / slice20.length) || 1;
  const z_sig   = Math.max(-1, Math.min(1, -(cur - mean20) / std20 / 2));
  const mr_sig  = (rsi_sig + z_sig) / 2;
  const mr_conf = Math.min(Math.abs(mr_sig) * 1.5, 1.0);

  // 3. Volume Expert (OBV slope)
  let obv = 0;
  const obvSeries: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    obv += closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0;
    obvSeries.push(obv);
  }
  const obvSlice = obvSeries.slice(-20);
  const obvMean  = obvSlice.reduce((a, b) => a + b, 0) / obvSlice.length;
  const ovStd    = Math.sqrt(obvSlice.reduce((a, b) => a + (b - obvMean) ** 2, 0) / obvSlice.length) || 1;
  const vol_sig  = Math.max(-1, Math.min(1, Math.tanh(obv / ovStd)));
  const vol_conf = Math.min(Math.abs(vol_sig) * 1.5, 1.0);

  // 4. Context (annualised volatility + trend)
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++)
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);

  const stdAll     = Math.sqrt(returns.reduce((a, b) => a + b * b, 0) / (returns.length || 1));
  const volatility = stdAll * annFactor;
  const trend      = Math.max(-1, Math.min(1, (cur - closes[0]) / closes[0] * 5));

  return [mom_sig, mom_conf, mr_sig, mr_conf, vol_sig, vol_conf, volatility * 10, trend, 0, 0];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function softmax(logits: number[]): number[] {
  const max  = Math.max(...logits);
  const exps = logits.map(x => Math.exp(x - max));
  const sum  = exps.reduce((a, b) => a + b, 0);
  return exps.map(x => x / sum);
}

function weightsToSignal(w: number[], features: number[]): number {
  const [mom_sig, mom_conf, mr_sig, mr_conf, vol_sig, vol_conf] = features;
  return w[0] * mom_sig * mom_conf + w[1] * mr_sig * mr_conf + w[2] * vol_sig * vol_conf;
}

function nextTradingDay(date: Date): Date {
  const d = new Date(date);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function zeroState(): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(LSTM_HIDDEN), [1, 1, LSTM_HIDDEN]);
}

async function fetchBars(
  symbol: string, interval: string, startEpoch: number, endEpoch: number
): Promise<OHLCVBar[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&period1=${startEpoch}&period2=${endEpoch}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
    if (!res.ok) return null;
    const json   = await res.json();
    const result = json.chart?.result?.[0];
    if (!result?.timestamp) return null;
    const q = result.indicators.quote[0];
    return result.timestamp
      .map((ts: number, i: number) => ({
        date:   new Date(ts * 1000).toISOString(),
        open:   q.open[i],
        high:   q.high[i],
        low:    q.low[i],
        close:  q.close[i],
        volume: q.volume[i],
      }))
      .filter((b: OHLCVBar) => b.close != null && b.volume != null);
  } catch {
    return null;
  }
}

// ─── Main route ───────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const amount    = parseFloat(searchParams.get('amount')    ?? '10000');
  const rawDate   = searchParams.get('startDate')            ?? '2024-01-15';
  const assetsRaw = searchParams.get('assets')               ?? 'SPY,QQQ,BTC-USD';
  const assets    = assetsRaw.split(',').map(a => a.trim().toUpperCase()).slice(0, 5);

  try {
    const session = await getOnnxSession();

    // 1. Resolve trading start date
    const inputDate  = new Date(rawDate + 'T12:00:00Z');
    const tradingDay = nextTradingDay(inputDate);
    const startISO   = tradingDay.toISOString().split('T')[0];

    const startEpoch = Math.floor(tradingDay.getTime() / 1000);
    const endEpoch   = Math.floor(Date.now() / 1000);

    const daysDiff  = (Date.now() - tradingDay.getTime()) / (1000 * 60 * 60 * 24);
    const interval  = daysDiff <= 55 ? '30m' : '1d';
    const annFactor = interval === '1d' ? Math.sqrt(252) : Math.sqrt(252 * 13);

    // 2. Fetch asset data + SPY benchmark in parallel
    const assetSymbols   = assets.includes('SPY') ? assets : [...assets, 'SPY'];
    const fetchedEntries = await Promise.all(
      assetSymbols.map(async sym => [sym, await fetchBars(sym, interval, startEpoch, endEpoch)] as const)
    );
    const assetData: Record<string, OHLCVBar[]> = {};
    for (const [sym, bars] of fetchedEntries) {
      if (bars && bars.length > 0) assetData[sym] = bars;
    }

    // Separate benchmark (SPY) from traded assets
    const spyBars: OHLCVBar[] | null = assetData['SPY'] ?? null;

    // Only keep user-requested assets for trading
    const availableAssets = assets
      .filter(sym => assetData[sym] && assetData[sym].length > 60)
      .map(sym => [sym, assetData[sym]] as [string, OHLCVBar[]]);

    if (availableAssets.length === 0) throw new Error('No valid asset data found for that date range');

    const LOOKBACK = 60;
    const numBars  = Math.min(...availableAssets.map(([_, b]) => b.length));
    const events:   TradeEvent[]   = [];
    const timeline: TimelinePoint[] = [];

    // Timeline sampling: cap at 600 points to keep response lean
    const TIMELINE_POINTS = 600;
    const sampleEvery     = Math.max(1, Math.floor((numBars - LOOKBACK) / TIMELINE_POINTS));

    // 3. Initialise portfolio: split evenly, buy at LOOKBACK bar
    const perAsset = amount / availableAssets.length;
    const holdings: Record<string, { shares: number }> = {};
    for (const [sym, bars] of availableAssets) {
      const price0  = bars[Math.min(LOOKBACK, bars.length - 1)].close;
      holdings[sym] = { shares: perAsset / price0 };
    }

    // SPY benchmark: same starting date, buy-and-hold
    let benchmarkShares = 0;
    if (spyBars && spyBars.length > LOOKBACK) {
      const spyPrice0 = spyBars[Math.min(LOOKBACK, spyBars.length - 1)].close;
      benchmarkShares = amount / spyPrice0;
    }

    // 4. Per-asset LSTM states (fixes TSLA/BTC never being reached)
    const lstmStates: Record<string, { h: ort.Tensor; c: ort.Tensor }> = {};
    const prevSignals: Record<string, number> = {};
    for (const [sym] of availableAssets) {
      lstmStates[sym] = { h: zeroState(), c: zeroState() };
      prevSignals[sym] = 0;
    }

    let portfolioValue = amount;
    let peakValue      = amount;
    let minValue       = amount;   // for proper max-drawdown (trough vs peak)
    let totalTrades    = 0;

    // ── Main simulation loop ──────────────────────────────────────────────────
    for (let step = LOOKBACK; step < numBars - 1; step++) {
      // Current portfolio mark-to-market
      const allocs: Record<string, number> = {};
      let totalVal = 0;
      for (const [sym, bars] of availableAssets) {
        const val   = holdings[sym].shares * bars[Math.min(step, bars.length - 1)].close;
        allocs[sym] = val;
        totalVal   += val;
      }
      portfolioValue = totalVal;
      peakValue      = Math.max(peakValue, portfolioValue);
      minValue       = Math.min(minValue, portfolioValue);

      // SPY benchmark value at this step
      const benchmarkValue = spyBars && spyBars.length > step
        ? benchmarkShares * spyBars[Math.min(step, spyBars.length - 1)].close
        : portfolioValue;

      // ── Per-asset inference (every asset gets own LSTM + own features) ──────
      let sumMom = 0, sumMr = 0, sumVol = 0, activeCnt = 0;

      for (const [sym, bars] of availableAssets) {
        if (step >= bars.length - 1) continue;
        const window = bars.slice(Math.max(0, step - LOOKBACK), step);
        if (window.length < LOOKBACK) continue;

        // Per-asset feature extraction (fixes SPY-only features applied to BTC)
        const features  = extractFeatures(window, annFactor);
        const obsTensor = new ort.Tensor('float32', Float32Array.from(features), [1, 10]);

        // Per-asset LSTM state threaded forward
        const { h, c } = lstmStates[sym];
        const result    = await session.run({ observation: obsTensor, h_in: h, c_in: c });
        lstmStates[sym].h = result.h_out as ort.Tensor;
        lstmStates[sym].c = result.c_out as ort.Tensor;

        const logits    = Array.from(result.expert_weights.data as Float32Array);
        const weights   = softmax(logits);
        const signal    = weightsToSignal(weights, features);
        const sigChange = Math.abs(signal - prevSignals[sym]);

        // Accumulate for timeline average
        sumMom += weights[0]; sumMr += weights[1]; sumVol += weights[2];
        activeCnt++;

        // Emit + execute trade on meaningful signal shift (>5%)
        if (sigChange > 0.05) {
          const price  = bars[step].close;
          const action: TradeEvent['action'] =
            signal > 0.1 ? 'BUY' : signal < -0.1 ? 'SELL' : 'REBALANCE';
          const tradeVal = Math.abs(signal) * (allocs[sym] || perAsset) * 0.1;
          const shares   = tradeVal / price;

          // Actually execute: update share count
          if (action === 'BUY') {
            holdings[sym].shares += shares;
          } else if (action === 'SELL') {
            holdings[sym].shares = Math.max(0, holdings[sym].shares - shares);
          }

          totalTrades++;
          events.push({
            timestamp:      bars[step].date,
            action,
            asset:          sym,
            shares:         parseFloat(shares.toFixed(4)),
            price:          parseFloat(price.toFixed(2)),
            portfolioValue: parseFloat(portfolioValue.toFixed(2)),
            pnl:            parseFloat((portfolioValue - amount).toFixed(2)),
            pnlPct:         parseFloat(((portfolioValue - amount) / amount * 100).toFixed(2)),
            allocation:     Object.fromEntries(
              Object.entries(allocs).map(([k, v]) => [k, parseFloat(v.toFixed(2))])
            ),
            weights: {
              momentum:      parseFloat(weights[0].toFixed(4)),
              meanReversion: parseFloat(weights[1].toFixed(4)),
              volume:        parseFloat(weights[2].toFixed(4)),
            },
          });
        }

        prevSignals[sym] = signal;
      }

      // Record sampled timeline point (used for equity curve + regime heatmap)
      if (activeCnt > 0 && (step % sampleEvery === 0 || step === numBars - 2)) {
        const avgMom = sumMom / activeCnt;
        const avgMr  = sumMr  / activeCnt;
        const avgVol = sumVol / activeCnt;
        const dominant: TimelinePoint['dominant'] =
          avgMom >= avgMr && avgMom >= avgVol ? 'momentum'
          : avgMr >= avgVol                   ? 'meanReversion'
          :                                     'volume';
        timeline.push({
          timestamp:      availableAssets[0][1][Math.min(step, availableAssets[0][1].length - 1)].date,
          portfolioValue: parseFloat(portfolioValue.toFixed(2)),
          benchmarkValue: parseFloat(benchmarkValue.toFixed(2)),
          dominant,
          weights: {
            momentum:      parseFloat(avgMom.toFixed(4)),
            meanReversion: parseFloat(avgMr.toFixed(4)),
            volume:        parseFloat(avgVol.toFixed(4)),
          },
        });
      }
    }

    // 5. Final portfolio snapshot
    let finalValue = 0;
    const finalAlloc: Record<string, number> = {};
    for (const [sym, bars] of availableAssets) {
      const price     = bars[bars.length - 1].close;
      const val       = holdings[sym].shares * price;
      finalAlloc[sym] = parseFloat(val.toFixed(2));
      finalValue     += val;
    }

    // Benchmark final value + alpha
    const benchmarkFinalValue = spyBars && spyBars.length > 0
      ? benchmarkShares * spyBars[spyBars.length - 1].close
      : amount;
    const benchmarkReturn = parseFloat(((benchmarkFinalValue - amount) / amount * 100).toFixed(2));
    const alpha           = parseFloat(((finalValue - amount) / amount * 100 - benchmarkReturn).toFixed(2));

    // Max drawdown: worst trough vs prior peak (not final vs peak)
    const maxDrawdown   = parseFloat(((peakValue - minValue) / peakValue * 100).toFixed(2));
    const winningTrades = events.filter(e => e.action === 'BUY').length;

    return NextResponse.json({
      startDate:     startISO,
      requestedDate: rawDate,
      amount,
      assets:        availableAssets.map(([s]) => s),
      events,
      timeline,
      summary: {
        finalValue:      parseFloat(finalValue.toFixed(2)),
        pnl:             parseFloat((finalValue - amount).toFixed(2)),
        pnlPct:          parseFloat(((finalValue - amount) / amount * 100).toFixed(2)),
        maxDrawdown,
        totalTrades,
        winRate:         totalTrades > 0
          ? parseFloat((winningTrades / totalTrades * 100).toFixed(1))
          : 0,
        finalAllocation: finalAlloc,
        benchmarkReturn,
        alpha,
      },
    });

  } catch (error: any) {
    console.error('Simulate error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
