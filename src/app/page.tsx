'use client';

import { useEffect, useState, useRef, FormEvent } from 'react';
import * as ort from 'onnxruntime-web';
import { Activity, Clock, ShieldAlert, Cpu, Search, BarChart2, AlertTriangle, Zap, Radio } from 'lucide-react';
import clsx from 'clsx';

// ─── Types ────────────────────────────────────────────────────────────────────
type OHLCV = { date: string; open: number; high: number; low: number; close: number; volume: number };

// ─── DSP helpers ──────────────────────────────────────────────────────────────
const sma    = (d: number[], w: number) => d.slice(-w).reduce((a, b) => a + b, 0) / w;
const stdDev = (d: number[]) => {
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  return Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length);
};

// ─── Feature extraction (matches training env exactly) ────────────────────────
const extractFeatures = (history: OHLCV[]) => {
  const closes  = history.map(h => h.close);
  const volumes = history.map(h => h.volume);
  const cur     = closes[closes.length - 1];

  const sma20 = sma(closes, 20), sma50 = sma(closes, 50);
  const mom_sig  = Math.max(-1, Math.min(1, ((sma20 - sma50) / cur) * 20));
  const mom_conf = Math.min(Math.abs(mom_sig), 1);

  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs      = losses === 0 ? 100 : (gains / 14) / (losses / 14);
  const rsi     = 100 - 100 / (1 + rs);
  const rsi_sig = Math.max(-1, Math.min(1, (50 - rsi) / 20));
  const s20     = closes.slice(-20);
  const m20     = s20.reduce((a, b) => a + b, 0) / s20.length;
  const z_sig   = Math.max(-1, Math.min(1, -(cur - m20) / (stdDev(s20) || 1) / 2));
  const mr_sig  = (rsi_sig + z_sig) / 2;
  const mr_conf = Math.min(Math.abs(mr_sig) * 1.5, 1);

  let obv = 0;
  const obvS: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    obv += closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0;
    obvS.push(obv);
  }
  const os  = obvS.slice(-20);
  const om  = os.reduce((a, b) => a + b, 0) / os.length;
  const ostd = Math.sqrt(os.reduce((a, b) => a + (b - om) ** 2, 0) / os.length) || 1;
  const vol_sig  = Math.max(-1, Math.min(1, Math.tanh(obv / ostd)));
  const vol_conf = Math.min(Math.abs(vol_sig) * 1.5, 1);

  const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const volatility_scaled = stdDev(returns) * Math.sqrt(252) * 10;
  const trend_scaled = Math.max(-1, Math.min(1, ((cur - closes[Math.max(0, closes.length - 100)]) / closes[Math.max(0, closes.length - 100)]) * 5));

  return [mom_sig, mom_conf, mr_sig, mr_conf, vol_sig, vol_conf, volatility_scaled, trend_scaled, 0, 0];
};

const TRAINED_TICKERS = new Set(['SPY']);

// ─── Circular Arc Gauge ───────────────────────────────────────────────────────
function ArcGauge({ value, label, color, sublabel }: {
  value: number; label: string; color: string; sublabel: string;
}) {
  const R    = 46;
  const cx   = 60;
  const cy   = 60;
  const circ = 2 * Math.PI * R;
  const arc  = circ * 0.75;               // 270° sweep
  const fill = value * arc;

  return (
    <div className="flex flex-col items-center justify-center">
      <svg width="120" height="110" viewBox="0 0 120 110" className="overflow-visible">
        {/* Track ring */}
        <circle cx={cx} cy={cy} r={R} fill="none"
          stroke="rgba(16,185,129,0.08)" strokeWidth="7"
          strokeDasharray={`${arc} ${circ - arc}`}
          transform={`rotate(135 ${cx} ${cy})`}
          strokeLinecap="round" />
        {/* Value ring */}
        <circle cx={cx} cy={cy} r={R} fill="none"
          stroke={color} strokeWidth="7"
          strokeDasharray={`${fill} ${circ - fill}`}
          transform={`rotate(135 ${cx} ${cy})`}
          strokeLinecap="round"
          style={{
            transition: 'stroke-dasharray 1.2s cubic-bezier(0.4,0,0.2,1)',
            filter: `drop-shadow(0 0 5px ${color})`,
          }} />
        {/* Glow behind ring */}
        <circle cx={cx} cy={cy} r={R} fill="none"
          stroke={color} strokeWidth="12"
          strokeDasharray={`${fill} ${circ - fill}`}
          transform={`rotate(135 ${cx} ${cy})`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 1.2s cubic-bezier(0.4,0,0.2,1)' }}
          opacity="0.06" />
        {/* Center value */}
        <text x={cx} y={cy - 8} textAnchor="middle"
          fill={color} fontSize="22" fontWeight="700" fontFamily="monospace"
          style={{ filter: `drop-shadow(0 0 4px ${color})` }}>
          {(value * 100).toFixed(1)}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle"
          fill={color} fontSize="12" fontFamily="monospace" opacity="0.6">%</text>
      </svg>
    </div>
  );
}

// ─── Expert Card ──────────────────────────────────────────────────────────────
function ExpertCard({ title, value, color, description, delay = '' }: {
  title: string; value: number; color: string; description: string; delay?: string;
}) {
  return (
    <div className={clsx('border bg-black rounded-lg p-6 card-tactical relative overflow-hidden animate-slide-up flex flex-col', delay)}
      style={{ borderColor: `${color}22` }}>
      {/* Top accent bar */}
      <div className="absolute top-0 left-0 right-0 h-px" style={{ backgroundColor: color, opacity: 0.5 }} />
      {/* Top progress bar */}
      <div className="absolute top-0 left-0 h-0.5 transition-all duration-1000 rounded-r"
        style={{ width: `${value * 100}%`, backgroundColor: color, boxShadow: `0 0 8px ${color}` }} />

      <div className="text-xs tracking-[0.2em] uppercase mb-4 font-medium" style={{ color: `${color}99` }}>
        {title}
      </div>

      <div className="flex items-center justify-between flex-1">
        <div className="flex-1">
          <div className="text-6xl font-bold tracking-tighter leading-none tabular-nums"
            style={{ color, textShadow: `0 0 20px ${color}60` }}>
            {(value * 100).toFixed(1)}<span className="text-3xl opacity-60">%</span>
          </div>

          {/* Mini bar */}
          <div className="mt-5 h-1 bg-emerald-950 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-1000"
              style={{ width: `${value * 100}%`, backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
          </div>

          <p className="text-xs mt-4 leading-relaxed" style={{ color: `${color}55` }}>
            {description}
          </p>
        </div>

        <div className="ml-4 shrink-0">
          <ArcGauge value={value} label={title} color={color} sublabel="weight" />
        </div>
      </div>
    </div>
  );
}

// ─── Signal classification ────────────────────────────────────────────────────
function SignalBadge({ weights }: { weights: { momentum: number; meanReversion: number; volume: number } }) {
  const dominant = Object.entries(weights).sort(([, a], [, b]) => b - a)[0][0];
  const label  = dominant === 'momentum' ? 'TRENDING'  : dominant === 'meanReversion' ? 'MEAN-REVERTING' : 'VOLUME-DRIVEN';
  const color  = dominant === 'momentum' ? '#10b981'  : dominant === 'meanReversion' ? '#f59e0b'        : '#8b5cf6';
  const action = dominant === 'momentum' ? 'FOLLOW TREND' : dominant === 'meanReversion' ? 'BUY DIPS / SELL RIPS' : 'WATCH OBV DIVERGENCE';

  return (
    <div className="border rounded-lg p-5 bg-black card-tactical animate-slide-up delay-400"
      style={{ borderColor: `${color}33` }}>
      <div className="text-xs tracking-[0.2em] uppercase mb-3" style={{ color: `${color}77` }}>ACTIVE REGIME</div>
      <div className="flex items-center gap-3 mb-3">
        <span className="w-2 h-2 rounded-full animate-pulse-dot" style={{ backgroundColor: color }} />
        <span className="text-xl font-bold tracking-tight" style={{ color, textShadow: `0 0 12px ${color}60` }}>
          {label}
        </span>
      </div>
      <div className="text-xs font-mono px-3 py-1.5 rounded inline-block"
        style={{ backgroundColor: `${color}11`, border: `1px solid ${color}33`, color: `${color}aa` }}>
        {action}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function BatcaveDashboard() {
  const [data, setData]       = useState<{ symbol: string; marketOpen: boolean; livePrice: number } | null>(null);
  const [weights, setWeights] = useState({ momentum: 0, meanReversion: 0, volume: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('');

  const [targetAsset, setTargetAsset] = useState('SPY');
  const [searchInput, setSearchInput] = useState('');

  const sessionRef = useRef<ort.InferenceSession | null>(null);
  const lstmHRef   = useRef<ort.Tensor | null>(null);
  const lstmCRef   = useRef<ort.Tensor | null>(null);
  const LSTM_HIDDEN = 256;

  useEffect(() => {
    lstmHRef.current = null;
    lstmCRef.current = null;

    const run = async () => {
      try {
        setLoading(true);
        setError(null);
        const res     = await fetch(`/api/market-data?symbol=${targetAsset}`);
        const payload = await res.json();
        if (payload.error) throw new Error(payload.error);
        setData(payload);

        const features = extractFeatures(payload.data);
        if (!sessionRef.current)
          sessionRef.current = await ort.InferenceSession.create('/hierarchical_moderator.onnx');

        const input = new ort.Tensor('float32', Float32Array.from(features), [1, 10]);
        const h     = lstmHRef.current ?? new ort.Tensor('float32', new Float32Array(LSTM_HIDDEN), [1, 1, LSTM_HIDDEN]);
        const c     = lstmCRef.current ?? new ort.Tensor('float32', new Float32Array(LSTM_HIDDEN), [1, 1, LSTM_HIDDEN]);
        const res2  = await sessionRef.current.run({ observation: input, h_in: h, c_in: c });

        lstmHRef.current = res2.h_out as ort.Tensor;
        lstmCRef.current = res2.c_out as ort.Tensor;

        const logits = res2.expert_weights.data as Float32Array;
        const e0 = Math.exp(logits[0]), e1 = Math.exp(logits[1]), e2 = Math.exp(logits[2]);
        const s  = e0 + e1 + e2;
        setWeights({ momentum: e0 / s, meanReversion: e1 / s, volume: e2 / s });
        setLastUpdate(new Date().toLocaleTimeString());
      } catch (err: any) {
        setError(err.message || 'Failed to load asset');
      } finally {
        setLoading(false);
      }
    };

    run();
    const iv = setInterval(run, 60000);
    return () => clearInterval(iv);
  }, [targetAsset]);

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) { setTargetAsset(searchInput.trim().toUpperCase()); setSearchInput(''); }
  };

  const isOOD = data && !TRAINED_TICKERS.has(data.symbol);

  return (
    <div className="min-h-screen bg-black text-emerald-400 font-mono selection:bg-emerald-900 selection:text-emerald-300 scanlines bg-grid relative">

      {/* Periodic scan line */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-40">
        <div className="animate-scan-line absolute w-full h-px bg-gradient-to-r from-transparent via-emerald-400/20 to-transparent" />
      </div>

      <div className="relative z-10 p-8">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-emerald-900/30 pb-7 mb-10 gap-6">
          <div className="animate-slide-up">
            <div className="flex items-center gap-3 mb-1">
              <ShieldAlert className="w-7 h-7 text-emerald-400 animate-glow-pulse" />
              <h1 className="text-2xl font-bold tracking-[0.05em] text-emerald-300 glow-emerald animate-flicker">
                BATCAVE TERMINAL
              </h1>
              <span className="text-xs border border-emerald-700/40 px-2 py-0.5 rounded text-emerald-700">v5.0</span>
            </div>
            <p className="text-emerald-900 text-xs tracking-[0.25em] uppercase pl-10">
              Hierarchical RL Engine // 3-Expert LSTM Ensemble // Edge Inference
            </p>
          </div>

          <div className="flex flex-wrap gap-3 items-center animate-slide-up delay-100">
            {/* Search */}
            <form onSubmit={handleSearch} className="relative">
              <input type="text" value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Ticker (e.g. TSLA, BTC-USD)"
                className="bg-emerald-950/20 border border-emerald-900/40 rounded px-4 py-2 pr-9 text-sm text-emerald-300 placeholder-emerald-900/60 focus:outline-none focus:border-emerald-600 transition-colors w-56" />
              <button type="submit" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-emerald-700 hover:text-emerald-400">
                <Search className="w-4 h-4" />
              </button>
            </form>

            {/* Simulator link */}
            <a href="/simulate" className="flex items-center gap-2 border border-emerald-900/40 bg-emerald-950/20 px-4 py-2 rounded text-sm text-emerald-700 hover:text-emerald-300 hover:border-emerald-700 transition-colors">
              <BarChart2 className="w-4 h-4" /> SIMULATOR
            </a>

            {/* Paper eval link */}
            <a href="/paper" className="flex items-center gap-2 border border-emerald-900/40 bg-emerald-950/20 px-4 py-2 rounded text-sm text-emerald-700 hover:text-emerald-300 hover:border-emerald-700 transition-colors">
              <Activity className="w-4 h-4" /> PAPER EVAL
            </a>

            {/* Inference chip */}
            <div className="flex items-center gap-2 border border-emerald-900/40 bg-emerald-950/20 px-3 py-2 rounded text-xs">
              <Cpu className="w-3.5 h-3.5 text-emerald-600" />
              <span className="text-emerald-900">INFERENCE</span>
              <span className="text-emerald-400">ONNX-WASM</span>
            </div>

            {/* Market status */}
            <div className={clsx('flex items-center gap-2 px-3 py-2 rounded border text-xs',
              data?.marketOpen
                ? 'border-emerald-700/40 bg-emerald-950/20 text-emerald-400'
                : 'border-red-900/40 bg-red-950/20 text-red-500')}>
              <span className={clsx('w-1.5 h-1.5 rounded-full', data?.marketOpen ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-500')} />
              NYSE {data?.marketOpen ? 'OPEN' : 'CLOSED'}
            </div>

            {/* Last update */}
            {lastUpdate && (
              <div className="text-xs text-emerald-900 flex items-center gap-1.5">
                <Clock className="w-3 h-3" /> {lastUpdate}
              </div>
            )}
          </div>
        </header>

        {/* OOD warning */}
        {isOOD && (
          <div className="flex items-start gap-3 border border-amber-900/40 bg-amber-950/10 rounded-lg px-4 py-3 mb-8 text-amber-600 text-xs animate-slide-up">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
            Model trained on <strong className="text-amber-400">SPY daily bars</strong>.
            Weights for <strong className="text-amber-400">{data?.symbol}</strong> are extrapolated — treat as indicative only.
          </div>
        )}

        {/* ── Body ──────────────────────────────────────────────────────── */}
        {error ? (
          <div className="flex justify-center items-center h-64 border border-red-900/30 bg-red-950/10 rounded-lg flex-col text-red-500 gap-3">
            <ShieldAlert className="w-10 h-10" />
            <p className="text-sm">ERROR: {error}</p>
            <p className="text-xs text-red-900">Invalid ticker or Yahoo Finance API unavailable.</p>
          </div>
        ) : loading && !data ? (
          <div className="flex justify-center items-center h-64 border border-emerald-900/20 bg-emerald-950/5 rounded-lg flex-col gap-4 text-emerald-800">
            <Activity className="w-8 h-8 animate-spin text-emerald-700" />
            <div className="text-xs tracking-widest uppercase cursor">LOADING MARKET DATA</div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Top row: ticker + experts */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">

              {/* ── Ticker panel ── */}
              <div className="border border-emerald-900/30 bg-black rounded-lg p-6 card-tactical animate-slide-up relative overflow-hidden">
                <div className="absolute inset-0 pointer-events-none"
                  style={{ background: 'radial-gradient(ellipse at top left, rgba(16,185,129,0.04) 0%, transparent 70%)' }} />
                <div className="text-xs tracking-[0.2em] uppercase text-emerald-900 mb-4">TARGET ASSET</div>

                <div className={clsx('font-bold tracking-tighter text-emerald-300 glow-emerald leading-none animate-flicker mb-6',
                  data && data.symbol.length > 5 ? 'text-4xl' : 'text-6xl')}>
                  {data?.symbol ?? '---'}
                </div>

                <div className="border-t border-emerald-900/20 pt-4 space-y-3">
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-emerald-900">LIVE PRICE</span>
                    <span className="text-2xl text-emerald-300 glow-emerald tabular-nums">
                      ${data?.livePrice?.toFixed(2) ?? '---'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-emerald-900">ENGINE</span>
                    <span className="text-xs flex items-center gap-1.5 text-emerald-700">
                      <Zap className="w-3 h-3" /> LSTM-256
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-emerald-900">POLLING</span>
                    <span className="text-xs text-emerald-700 flex items-center gap-1.5">
                      <Radio className="w-3 h-3" /> 60s
                    </span>
                  </div>
                </div>
              </div>

              {/* ── Expert cards ── */}
              <ExpertCard
                title="Momentum Expert"
                value={weights.momentum}
                color="#10b981"
                description="SMA/EMA crossovers and ROC breakouts. High weight = strong trending regime."
                delay="delay-100"
              />
              <ExpertCard
                title="Mean Reversion Expert"
                value={weights.meanReversion}
                color="#f59e0b"
                description="RSI extrema and Bollinger Z-scores. High weight = ranging / volatile regime."
                delay="delay-200"
              />
              <ExpertCard
                title="Volume Expert"
                value={weights.volume}
                color="#8b5cf6"
                description="OBV divergence and VWAP deviation. High weight = institutional flow detected."
                delay="delay-300"
              />
            </div>

            {/* Second row: regime classification + feature breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <SignalBadge weights={weights} />

              {/* Feature breakdown */}
              {(['momentum', 'meanReversion', 'volume'] as const).map((key, idx) => {
                const w     = weights[key];
                const color = key === 'momentum' ? '#10b981' : key === 'meanReversion' ? '#f59e0b' : '#8b5cf6';
                const label = key === 'momentum' ? 'MOM' : key === 'meanReversion' ? 'M.R.' : 'VOL';
                const delays = ['delay-500', 'delay-500', 'delay-500'];
                return (
                  <div key={key}
                    className={clsx('border bg-black rounded-lg p-5 card-tactical animate-slide-up', delays[idx])}
                    style={{ borderColor: `${color}22` }}>
                    <div className="flex justify-between items-start mb-4">
                      <span className="text-xs tracking-widest" style={{ color: `${color}77` }}>{label} SIGNAL STRENGTH</span>
                      <span className="text-xs font-bold tabular-nums" style={{ color }}>{(w * 100).toFixed(1)}%</span>
                    </div>
                    <div className="space-y-2">
                      {[0.2, 0.4, 0.6, 0.8, 1.0].map(threshold => (
                        <div key={threshold} className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: `${color}11` }}>
                            <div className="h-full rounded-full transition-all duration-1000"
                              style={{
                                width: `${Math.min(100, (w / threshold) * 100)}%`,
                                backgroundColor: color,
                                opacity: w >= threshold ? 0.9 : 0.2,
                              }} />
                          </div>
                          <span className="text-xs w-8 text-right tabular-nums" style={{ color: `${color}55` }}>
                            {(threshold * 100).toFixed(0)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="mt-20 border-t border-emerald-900/20 pt-6 text-xs text-emerald-900/60 flex justify-between items-center">
          <span>BATCAVE TERMINAL v5.0 // V5 LSTM MODEL // 3-EXPERT ENSEMBLE</span>
          <span className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-700 animate-pulse-dot" />
            EDGE NODE ACTIVE
          </span>
        </footer>
      </div>
    </div>
  );
}
