'use client';

import { useState, useEffect, useRef, FormEvent } from 'react';
import {
  Activity, Play, Pause, RotateCcw, TrendingUp, TrendingDown,
  DollarSign, BarChart2, Zap, Clock, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import clsx from 'clsx';

// ─── Types ────────────────────────────────────────────────────────────────────
interface TradeEvent {
  timestamp: string;
  action: 'BUY' | 'SELL' | 'HOLD' | 'REBALANCE';
  asset: string;
  shares: number;
  price: number;
  portfolioValue: number;
  pnl: number;
  pnlPct: number;
  allocation: Record<string, number>;
  weights: { momentum: number; meanReversion: number; volume: number };
}

interface TimelinePoint {
  timestamp:      string;
  portfolioValue: number;
  benchmarkValue: number;
  dominant:       'momentum' | 'meanReversion' | 'volume';
  weights:        { momentum: number; meanReversion: number; volume: number };
}

interface SimResults {
  startDate: string;
  requestedDate: string;
  amount: number;
  assets: string[];
  events: TradeEvent[];
  timeline: TimelinePoint[];
  summary: {
    finalValue: number;
    pnl: number;
    pnlPct: number;
    maxDrawdown: number;
    totalTrades: number;
    winRate: number;
    finalAllocation: Record<string, number>;
    benchmarkReturn: number;
    alpha: number;
  };
}

const SPEEDS       = [1, 1.25, 1.5, 2] as const;
const SPEED_LABELS = ['1×', '1.25×', '1.5×', '2×'];
const PRESET_ASSETS = ['SPY', 'QQQ', 'BTC-USD', 'AAPL', 'TSLA'];

const REGIME = {
  momentum:      { color: '#10b981', label: 'MOM' },
  meanReversion: { color: '#f59e0b', label: 'MR' },
  volume:        { color: '#8b5cf6', label: 'VOL' },
} as const;

const BOOT_LINES = [
  'INITIALIZING BACKTESTING ENGINE...',
  'FETCHING MARKET DATA FROM YAHOO FINANCE...',
  'SPAWNING PER-ASSET LSTM CONTEXTS...',
  'CALIBRATING SORTINO REWARD FUNCTION...',
  'RUNNING SEQUENTIAL ONNX INFERENCE...',
  'COMPUTING PORTFOLIO TRAJECTORY...',
  'GENERATING REGIME HEATMAP...',
  'CALCULATING ALPHA VS BENCHMARK...',
];

// ─── Terminal boot sequence ───────────────────────────────────────────────────
function TerminalBoot() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let i = 0;
    const t = setInterval(() => {
      if (i < BOOT_LINES.length) { setLines(p => [...p, BOOT_LINES[i++]]); }
      else clearInterval(t);
    }, 420);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="h-80 border border-emerald-900/30 bg-emerald-950/5 rounded-lg p-7 flex flex-col justify-center">
      <div className="text-xs text-emerald-800 tracking-widest uppercase mb-6">// BACKTESTING ENGINE</div>
      <div className="space-y-2">
        {lines.map((line, i) => (
          <div key={i} className="text-xs text-emerald-700 flex items-center gap-3 animate-data-in">
            <span className="text-emerald-500 shrink-0">▶</span>
            <span>{line}</span>
            {i === lines.length - 1 && <span className="animate-blink text-emerald-400 ml-1">▌</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Equity Curve with grid + benchmark overlay ───────────────────────────────
function EquityCurve({ timeline, amount }: { timeline: TimelinePoint[]; amount: number }) {
  if (timeline.length < 2) return null;

  const W  = 600;
  const H  = 160;
  const PL = 58;   // left padding for axis labels
  const PB = 24;   // bottom padding for date labels
  const PT = 8;
  const PR = 8;
  const IW = W - PL - PR;
  const IH = H - PT - PB;

  const allVals = timeline.flatMap(t => [t.portfolioValue, t.benchmarkValue]);
  const minV    = Math.min(...allVals, amount * 0.85);
  const maxV    = Math.max(...allVals, amount * 1.05);
  const range   = maxV - minV || 1;

  const toX = (i: number) => PL + (i / (timeline.length - 1)) * IW;
  const toY = (v: number) => PT + IH - ((v - minV) / range) * IH;

  const portPts  = timeline.map((t, i) => `${toX(i)},${toY(t.portfolioValue)}`).join(' ');
  const benchPts = timeline.map((t, i) => `${toX(i)},${toY(t.benchmarkValue)}`).join(' ');

  const final    = timeline[timeline.length - 1].portfolioValue;
  const positive = final >= amount;
  const lineColor = positive ? '#10b981' : '#ef4444';
  const baseY     = toY(amount);

  // Grid levels
  const gridLevels = [0, 0.25, 0.5, 0.75, 1];
  const fmt = (v: number) =>
    v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000   ? `$${(v / 1_000).toFixed(0)}K`
    :                `$${v.toFixed(0)}`;

  // Date labels
  const startDate = timeline[0].timestamp.split('T')[0];
  const endDate   = timeline[timeline.length - 1].timestamp.split('T')[0];
  const midDate   = timeline[Math.floor(timeline.length / 2)].timestamp.split('T')[0];

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-44">
        <defs>
          <linearGradient id="portFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={lineColor} stopOpacity="0.18" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0.01" />
          </linearGradient>
          <clipPath id="chartClip">
            <rect x={PL} y={PT} width={IW} height={IH} />
          </clipPath>
          <filter id="lineGlow">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        {/* Grid lines */}
        {gridLevels.map(lvl => {
          const y   = PT + IH - lvl * IH;
          const val = minV + lvl * range;
          return (
            <g key={lvl}>
              <line x1={PL} y1={y} x2={W - PR} y2={y}
                stroke="rgba(16,185,129,0.07)" strokeWidth="1" strokeDasharray="3 5" />
              <text x={PL - 4} y={y + 3.5} textAnchor="end"
                fill="rgba(16,185,129,0.25)" fontSize="8.5" fontFamily="monospace">
                {fmt(val)}
              </text>
            </g>
          );
        })}

        {/* Chart area */}
        <g clipPath="url(#chartClip)">
          {/* Portfolio fill */}
          <polygon points={`${PL},${PT + IH} ${portPts} ${W - PR},${PT + IH}`} fill="url(#portFill)" />
          {/* Baseline */}
          <line x1={PL} y1={baseY} x2={W - PR} y2={baseY}
            stroke="rgba(55,65,81,0.8)" strokeWidth="1" strokeDasharray="4 4" />
          {/* Benchmark */}
          <polyline points={benchPts} fill="none"
            stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="5 3" opacity="0.55" />
          {/* Portfolio line */}
          <polyline points={portPts} fill="none" stroke={lineColor} strokeWidth="2"
            filter="url(#lineGlow)" />
          {/* End dot */}
          <circle cx={toX(timeline.length - 1)} cy={toY(final)} r="3.5"
            fill={lineColor} style={{ filter: `drop-shadow(0 0 4px ${lineColor})` }} />
        </g>

        {/* Left axis border */}
        <line x1={PL} y1={PT} x2={PL} y2={PT + IH} stroke="rgba(16,185,129,0.12)" strokeWidth="1" />

        {/* Date labels */}
        <text x={PL} y={H - 4} textAnchor="start" fill="rgba(16,185,129,0.25)" fontSize="8.5" fontFamily="monospace">{startDate}</text>
        <text x={PL + IW / 2} y={H - 4} textAnchor="middle" fill="rgba(16,185,129,0.18)" fontSize="8.5" fontFamily="monospace">{midDate}</text>
        <text x={W - PR} y={H - 4} textAnchor="end" fill="rgba(16,185,129,0.25)" fontSize="8.5" fontFamily="monospace">{endDate}</text>
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-6 mt-2 text-xs text-emerald-900">
        <span className="flex items-center gap-2">
          <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke={lineColor} strokeWidth="2"/></svg>
          Portfolio
        </span>
        <span className="flex items-center gap-2">
          <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="5 3"/></svg>
          SPY B&amp;H
        </span>
        <span className="flex items-center gap-2">
          <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#374151" strokeWidth="1" strokeDasharray="4 4"/></svg>
          Initial
        </span>
      </div>
    </div>
  );
}

// ─── Regime Heatmap ───────────────────────────────────────────────────────────
function RegimeHeatmap({ timeline }: { timeline: TimelinePoint[] }) {
  if (timeline.length === 0) return null;

  type Seg = { dominant: TimelinePoint['dominant']; sf: number; ef: number };
  const segs: Seg[] = [];
  let cur = timeline[0].dominant, start = 0;
  for (let i = 1; i <= timeline.length; i++) {
    const next = i < timeline.length ? timeline[i].dominant : null;
    if (next !== cur) {
      segs.push({ dominant: cur, sf: start / timeline.length, ef: i / timeline.length });
      if (next) { cur = next; start = i; }
    }
  }

  const tally = { momentum: 0, meanReversion: 0, volume: 0 };
  for (const t of timeline) tally[t.dominant]++;
  const total = timeline.length;

  return (
    <div className="border border-emerald-900/30 bg-black rounded-lg p-5 card-tactical">
      <div className="flex justify-between items-center mb-4">
        <div className="text-xs tracking-[0.2em] uppercase text-emerald-900">Regime Heatmap</div>
        <div className="flex items-center gap-5">
          {(Object.keys(REGIME) as (keyof typeof REGIME)[]).map(r => (
            <span key={r} className="flex items-center gap-1.5 text-xs text-emerald-900">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: REGIME[r].color, boxShadow: `0 0 4px ${REGIME[r].color}` }} />
              {REGIME[r].label}
              <span className="tabular-nums" style={{ color: `${REGIME[r].color}88` }}>
                {((tally[r] / total) * 100).toFixed(0)}%
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Segmented bar */}
      <div className="h-8 flex rounded overflow-hidden gap-px">
        {segs.map((seg, i) => (
          <div key={i}
            style={{
              width:           `${(seg.ef - seg.sf) * 100}%`,
              backgroundColor: REGIME[seg.dominant].color,
              boxShadow:       `inset 0 0 12px rgba(0,0,0,0.3)`,
              opacity:         0.75,
            }}
            title={`${seg.dominant} · ${(seg.sf * 100).toFixed(0)}%–${(seg.ef * 100).toFixed(0)}%`}
          />
        ))}
      </div>

      <div className="flex justify-between text-xs text-emerald-900/40 mt-2">
        <span>{timeline[0]?.timestamp.split('T')[0]}</span>
        <span>{timeline[timeline.length - 1]?.timestamp.split('T')[0]}</span>
      </div>
    </div>
  );
}

// ─── Metric card ──────────────────────────────────────────────────────────────
function MetricCard({
  label, value, sub, positive, accent, large = false,
}: {
  label: string; value: string; sub?: string; positive?: boolean; accent?: string; large?: boolean;
}) {
  const color = positive === undefined ? '#10b981' : positive ? '#10b981' : '#ef4444';
  return (
    <div className="border border-emerald-900/30 bg-black rounded-lg p-4 card-tactical relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-px" style={{ backgroundColor: color, opacity: 0.3 }} />
      <div className="text-xs tracking-[0.15em] uppercase text-emerald-900 mb-2">{label}</div>
      <div className={clsx('font-bold tabular-nums leading-none', large ? 'text-2xl' : 'text-xl')}
        style={{ color, textShadow: `0 0 16px ${color}50` }}>
        {value}
      </div>
      {sub && <div className="text-xs mt-1" style={{ color: `${color}66` }}>{sub}</div>}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function SimulatePage() {
  const [amount, setAmount]         = useState('10000');
  const [startDate, setStartDate]   = useState('2024-01-15');
  const [selectedAssets, setAssets] = useState<string[]>(['SPY', 'QQQ', 'BTC-USD']);
  const [customAsset, setCustom]    = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [results, setResults] = useState<SimResults | null>(null);

  const [playing, setPlaying]         = useState(false);
  const [speed, setSpeed]             = useState<typeof SPEEDS[number]>(1);
  const [playheadIdx, setPlayheadIdx] = useState(0);
  const [visibleEvents, setVisible]   = useState<TradeEvent[]>([]);
  const intervalRef                   = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef                        = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [visibleEvents]);

  useEffect(() => {
    if (!results) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (playing && playheadIdx < results.events.length) {
      intervalRef.current = setInterval(() => {
        setPlayheadIdx(prev => {
          const next = prev + 1;
          setVisible(results.events.slice(0, next));
          if (next >= results.events.length) setPlaying(false);
          return next;
        });
      }, Math.round(600 / speed));
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing, speed, results, playheadIdx]);

  const restart = () => { setPlaying(false); setPlayheadIdx(0); setVisible([]); };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (selectedAssets.length === 0) { setError('Select at least one asset'); return; }
    setLoading(true); setError(null); setResults(null); restart();
    try {
      const res  = await fetch(`/api/simulate?amount=${amount}&startDate=${startDate}&assets=${selectedAssets.join(',')}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const currentEvent  = visibleEvents[visibleEvents.length - 1];
  const currentValue  = currentEvent?.portfolioValue ?? (results?.amount ?? null);
  const currentPnl    = currentValue != null && results ? currentValue - results.amount : null;
  const currentPnlPct = currentPnl   != null && results ? (currentPnl / results.amount * 100) : null;
  const progress      = results ? (playheadIdx / Math.max(results.events.length, 1)) * 100 : 0;
  const isPositive    = (currentPnl ?? 0) >= 0;

  return (
    <div className="min-h-screen bg-black text-emerald-400 font-mono selection:bg-emerald-900 bg-grid scanlines relative">

      {/* Scan line */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-40">
        <div className="animate-scan-line absolute w-full h-px bg-gradient-to-r from-transparent via-emerald-400/15 to-transparent" />
      </div>

      <div className="relative z-10 p-6">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="flex justify-between items-center border-b border-emerald-900/30 pb-5 mb-8">
          <div>
            <h1 className="text-xl font-bold text-emerald-300 glow-emerald flex items-center gap-2 tracking-wide">
              <BarChart2 className="w-5 h-5" /> PORTFOLIO SIMULATOR
            </h1>
            <p className="text-emerald-900 text-xs mt-1 tracking-[0.2em] uppercase">
              Hierarchical RL Engine // Historical Backtest Replay
            </p>
          </div>
          <a href="/" className="text-xs text-emerald-900 hover:text-emerald-400 border border-emerald-900/30 hover:border-emerald-700 px-3 py-1.5 rounded transition-colors">
            ← LIVE DASHBOARD
          </a>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* ── LEFT ──────────────────────────────────────────────────────── */}
          <div className="xl:col-span-1 space-y-5">

            {/* Parameters form */}
            <div className="border border-emerald-900/30 bg-black rounded-lg p-5 space-y-5 card-tactical">
              <div className="text-xs tracking-[0.2em] uppercase text-emerald-900">Simulation Parameters</div>

              <div>
                <label className="text-xs text-emerald-800 mb-1.5 block">Initial Investment (USD)</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-emerald-800"><DollarSign className="w-4 h-4" /></span>
                  <input type="number" min="100" step="100" value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="w-full bg-emerald-950/10 border border-emerald-900/40 rounded pl-9 pr-4 py-2.5 text-emerald-300 focus:outline-none focus:border-emerald-600 transition-colors text-sm" />
                </div>
              </div>

              <div>
                <label className="text-xs text-emerald-800 mb-1.5 block flex items-center gap-2">
                  <Clock className="w-3 h-3" /> Start Date
                  <span className="text-emerald-900/60">(adjusts to next trading day)</span>
                </label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                  className="w-full bg-emerald-950/10 border border-emerald-900/40 rounded px-4 py-2.5 text-emerald-300 focus:outline-none focus:border-emerald-600 transition-colors text-sm" />
              </div>

              <div>
                <label className="text-xs text-emerald-800 mb-2 block">Assets <span className="text-emerald-900/60">(max 5)</span></label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {PRESET_ASSETS.map(a => (
                    <button key={a} type="button"
                      onClick={() => setAssets(p => p.includes(a) ? p.filter(x => x !== a) : p.length < 5 ? [...p, a] : p)}
                      className={clsx('px-2.5 py-1 rounded text-xs border transition-all',
                        selectedAssets.includes(a)
                          ? 'bg-emerald-900/30 border-emerald-600/60 text-emerald-300'
                          : 'border-emerald-900/30 text-emerald-900 hover:border-emerald-800 hover:text-emerald-700')}>
                      {a}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input type="text" placeholder="Custom ticker…" value={customAsset}
                    onChange={e => setCustom(e.target.value.toUpperCase())}
                    className="flex-1 bg-emerald-950/10 border border-emerald-900/40 rounded px-3 py-1.5 text-xs text-emerald-300 focus:outline-none focus:border-emerald-600 transition-colors" />
                  <button type="button"
                    onClick={() => { if (customAsset && selectedAssets.length < 5) { setAssets(p => [...p, customAsset]); setCustom(''); } }}
                    className="px-3 py-1.5 border border-emerald-800/50 rounded text-xs text-emerald-700 hover:bg-emerald-900/20 transition-colors">Add</button>
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {selectedAssets.map(a => (
                    <span key={a} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-emerald-800/40 bg-emerald-950/20 text-emerald-500">
                      {a}
                      <button type="button" onClick={() => setAssets(p => p.filter(x => x !== a))} className="text-emerald-800 hover:text-red-400 ml-0.5">×</button>
                    </span>
                  ))}
                </div>
              </div>

              <button onClick={handleSubmit} disabled={loading}
                className="w-full py-2.5 bg-emerald-950/30 border border-emerald-700/50 text-emerald-300 rounded hover:bg-emerald-900/30 hover:border-emerald-500 transition-all font-semibold flex items-center justify-center gap-2 text-sm group">
                {loading
                  ? <><Activity className="w-4 h-4 animate-spin" /> Computing…</>
                  : <><Zap className="w-4 h-4 group-hover:animate-glow-pulse" /> Run Simulation</>}
              </button>

              {error && (
                <div className="text-red-400 text-xs border border-red-900/40 bg-red-950/10 px-3 py-2 rounded">{error}</div>
              )}
            </div>

            {/* Summary card */}
            {results && (
              <div className="border border-emerald-900/30 bg-black rounded-lg p-5 card-tactical animate-slide-up">
                <div className="text-xs tracking-[0.2em] uppercase text-emerald-900 mb-4">Final Summary</div>
                <div className="space-y-2.5">
                  {([
                    ['Start Date',   results.startDate,  undefined],
                    ['Initial',      `$${results.amount.toLocaleString()}`, undefined],
                    ['Final Value',  `$${results.summary.finalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}`, undefined],
                    ['Return',       `${results.summary.pnlPct >= 0 ? '+' : ''}${results.summary.pnlPct.toFixed(2)}%`, results.summary.pnlPct >= 0],
                    ['SPY B&H',      `${results.summary.benchmarkReturn >= 0 ? '+' : ''}${results.summary.benchmarkReturn.toFixed(2)}%`, results.summary.benchmarkReturn >= 0],
                    ['Alpha',        `${results.summary.alpha >= 0 ? '+' : ''}${results.summary.alpha.toFixed(2)}%`, results.summary.alpha >= 0],
                    ['Max Drawdown', `${results.summary.maxDrawdown.toFixed(2)}%`, false],
                    ['Total Trades', results.summary.totalTrades.toString(), undefined],
                    ['Win Rate',     `${results.summary.winRate}%`, results.summary.winRate >= 50],
                  ] as [string, string, boolean | undefined][]).map(([label, val, pos]) => (
                    <div key={label} className="flex justify-between items-center py-1.5 border-b border-emerald-900/15 last:border-0">
                      <span className="text-xs text-emerald-900">{label}</span>
                      <span className={clsx('text-xs font-semibold tabular-nums',
                        pos === true  ? 'text-emerald-400' :
                        pos === false ? 'text-red-400' :
                                        'text-emerald-300')}>
                        {label === 'Alpha' && results.summary.alpha >= 0
                          ? <span className="flex items-center gap-1"><ArrowUpRight className="w-3 h-3" />{val}</span>
                          : label === 'Alpha' && results.summary.alpha < 0
                          ? <span className="flex items-center gap-1"><ArrowDownRight className="w-3 h-3" />{val}</span>
                          : val}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── RIGHT ─────────────────────────────────────────────────────── */}
          <div className="xl:col-span-2 space-y-5">

            {/* Empty / loading state */}
            {!results && !loading && (
              <div className="h-96 border border-emerald-900/20 bg-emerald-950/5 rounded-lg flex flex-col items-center justify-center text-emerald-900 gap-4">
                <BarChart2 className="w-14 h-14 opacity-40" />
                <p className="text-sm tracking-widest uppercase">Configure parameters and run a simulation</p>
              </div>
            )}
            {loading && <TerminalBoot />}

            {results && (
              <>
                {/* Live metrics */}
                <div className="grid grid-cols-3 gap-4">
                  {/* Portfolio value */}
                  <div className={clsx('border rounded-lg p-4 bg-black card-tactical relative overflow-hidden', isPositive ? 'border-emerald-900/40' : 'border-red-900/40')}>
                    <div className="absolute inset-x-0 top-0 h-px" style={{ backgroundColor: isPositive ? '#10b981' : '#ef4444', opacity: 0.4 }} />
                    <div className="text-xs tracking-[0.15em] uppercase text-emerald-900 mb-2">Portfolio Value</div>
                    <div className="text-xl font-bold tabular-nums leading-tight"
                      style={{ color: isPositive ? '#10b981' : '#ef4444', textShadow: `0 0 16px ${isPositive ? '#10b98150' : '#ef444450'}` }}>
                      ${(currentValue ?? results.amount).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </div>
                  </div>

                  {/* P&L */}
                  <div className={clsx('border rounded-lg p-4 bg-black card-tactical', isPositive ? 'border-emerald-900/40' : 'border-red-900/40')}>
                    <div className="text-xs tracking-[0.15em] uppercase text-emerald-900 mb-2">P&amp;L</div>
                    <div className={clsx('text-xl font-bold flex items-center gap-1 tabular-nums', isPositive ? 'text-emerald-400' : 'text-red-400')}
                      style={{ textShadow: `0 0 14px ${isPositive ? '#10b98140' : '#ef444440'}` }}>
                      {isPositive ? <TrendingUp className="w-4 h-4 shrink-0" /> : <TrendingDown className="w-4 h-4 shrink-0" />}
                      {currentPnl != null ? `${currentPnl >= 0 ? '+' : ''}$${Math.abs(currentPnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '$0'}
                    </div>
                    <div className="text-xs mt-1" style={{ color: isPositive ? '#10b98166' : '#ef444466' }}>
                      {currentPnlPct != null ? `${currentPnlPct >= 0 ? '+' : ''}${currentPnlPct.toFixed(2)}%` : '0.00%'}
                    </div>
                  </div>

                  {/* Expert weights */}
                  <div className="border border-emerald-900/30 rounded-lg p-4 bg-black card-tactical">
                    <div className="text-xs tracking-[0.15em] uppercase text-emerald-900 mb-3">Expert Weights</div>
                    {currentEvent ? (
                      <div className="space-y-2">
                        {(['momentum', 'meanReversion', 'volume'] as const).map(key => {
                          const w   = currentEvent.weights[key];
                          const col = REGIME[key].color;
                          return (
                            <div key={key} className="flex items-center gap-2">
                              <span className="text-xs w-7 shrink-0" style={{ color: `${col}99` }}>{REGIME[key].label}</span>
                              <div className="flex-1 h-1.5 bg-emerald-950/80 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-700"
                                  style={{ width: `${(w * 100).toFixed(0)}%`, backgroundColor: col, boxShadow: `0 0 5px ${col}` }} />
                              </div>
                              <span className="text-xs w-8 text-right tabular-nums" style={{ color: col }}>{(w * 100).toFixed(0)}%</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : <span className="text-xs text-emerald-900">Press play to begin</span>}
                  </div>
                </div>

                {/* Equity curve */}
                <div className="border border-emerald-900/30 bg-black rounded-lg p-5 card-tactical">
                  <div className="flex justify-between items-center mb-4">
                    <div className="text-xs tracking-[0.2em] uppercase text-emerald-900">Equity Curve</div>
                    {results.summary.alpha !== undefined && (
                      <div className={clsx('text-xs px-2.5 py-1 rounded border tabular-nums',
                        results.summary.alpha >= 0
                          ? 'border-emerald-800/40 text-emerald-500 bg-emerald-950/20'
                          : 'border-red-900/40 text-red-500 bg-red-950/10')}>
                        {results.summary.alpha >= 0 ? '▲' : '▼'} {Math.abs(results.summary.alpha).toFixed(2)}% vs SPY
                      </div>
                    )}
                  </div>
                  <EquityCurve timeline={results.timeline} amount={results.amount} />
                  {/* Progress bar */}
                  <div className="h-0.5 bg-emerald-950 rounded mt-4 overflow-hidden">
                    <div className="h-full bg-emerald-600 rounded transition-all duration-300"
                      style={{ width: `${progress}%`, boxShadow: '0 0 6px #10b981' }} />
                  </div>
                </div>

                {/* Regime heatmap */}
                <RegimeHeatmap timeline={results.timeline} />

                {/* Controls */}
                <div className="border border-emerald-900/30 bg-black rounded-lg p-4 flex flex-wrap items-center gap-3">
                  <button onClick={() => setPlaying(p => !p)} disabled={playheadIdx >= results.events.length}
                    className="flex items-center gap-2 px-4 py-2 border border-emerald-700/50 rounded text-emerald-300 hover:bg-emerald-900/20 transition-all text-sm">
                    {playing ? <><Pause className="w-4 h-4" />Pause</> : <><Play className="w-4 h-4" />Play</>}
                  </button>
                  <button onClick={restart}
                    className="flex items-center gap-2 px-4 py-2 border border-emerald-900/30 rounded text-emerald-800 hover:text-emerald-500 hover:border-emerald-700 transition-all text-sm">
                    <RotateCcw className="w-4 h-4" /> Restart
                  </button>
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-xs text-emerald-900 mr-1">SPEED</span>
                    {SPEEDS.map((s, i) => (
                      <button key={s} onClick={() => setSpeed(s)}
                        className={clsx('px-2.5 py-1 rounded text-xs border transition-all',
                          speed === s
                            ? 'bg-emerald-900/30 border-emerald-600/60 text-emerald-300'
                            : 'border-emerald-900/30 text-emerald-900 hover:border-emerald-800')}>
                        {SPEED_LABELS[i]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Trade event log */}
                <div className="border border-emerald-900/30 bg-black rounded-lg overflow-hidden card-tactical">
                  <div className="px-5 py-3 border-b border-emerald-900/20 flex justify-between items-center">
                    <span className="text-xs tracking-[0.15em] uppercase text-emerald-900">Trade Event Log</span>
                    <span className="text-xs text-emerald-900/40 tabular-nums">
                      {visibleEvents.length} <span className="text-emerald-900/20">/</span> {results.events.length}
                    </span>
                  </div>
                  <div ref={logRef} className="h-56 overflow-y-auto p-3 space-y-1">
                    {visibleEvents.length === 0 && (
                      <div className="text-center text-emerald-900/40 text-xs pt-10 tracking-widest uppercase">
                        Press play to replay simulation…
                      </div>
                    )}
                    {visibleEvents.map((ev, i) => {
                      const isB = ev.action === 'BUY', isS = ev.action === 'SELL';
                      const col = isB ? '#10b981' : isS ? '#ef4444' : '#f59e0b';
                      return (
                        <div key={i} className="flex items-center gap-3 px-3 py-2 rounded text-xs transition-all animate-data-in"
                          style={{ borderLeft: `2px solid ${col}55`, backgroundColor: `${col}06` }}>
                          <span className="font-bold shrink-0 w-16 tabular-nums" style={{ color: col }}>
                            {ev.action}
                          </span>
                          <span className="shrink-0 text-emerald-800 tabular-nums">
                            {ev.shares.toFixed(2)}
                          </span>
                          <span className="font-medium shrink-0" style={{ color: col + 'cc' }}>
                            {ev.asset}
                          </span>
                          <span className="text-emerald-900 tabular-nums">@ ${ev.price.toFixed(2)}</span>
                          <span className="ml-auto text-emerald-900/60 tabular-nums shrink-0">
                            ${ev.portfolioValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Asset allocation */}
                {currentEvent && (
                  <div className="border border-emerald-900/30 bg-black rounded-lg p-5 card-tactical">
                    <div className="text-xs tracking-[0.2em] uppercase text-emerald-900 mb-4">Portfolio Allocation</div>
                    <div className="space-y-3">
                      {Object.entries(currentEvent.allocation)
                        .sort(([, a], [, b]) => b - a)
                        .map(([asset, val]) => {
                          const total = Object.values(currentEvent.allocation).reduce((a, b) => a + b, 0);
                          const pct   = total > 0 ? (val / total) * 100 : 0;
                          return (
                            <div key={asset} className="flex items-center gap-3 text-sm">
                              <span className="text-emerald-500 w-20 shrink-0 text-xs font-medium">{asset}</span>
                              <div className="flex-1 h-1.5 bg-emerald-950/60 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-700"
                                  style={{ width: `${pct.toFixed(1)}%`, backgroundColor: '#10b981', boxShadow: '0 0 6px #10b98160' }} />
                              </div>
                              <span className="text-emerald-800 text-xs tabular-nums w-20 text-right">
                                ${val.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                              </span>
                              <span className="text-emerald-900 text-xs tabular-nums w-10 text-right">{pct.toFixed(1)}%</span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="mt-16 border-t border-emerald-900/20 pt-6 text-xs text-emerald-900/40 flex justify-between items-center">
          <span className="tracking-widest uppercase">BATCAVE TERMINAL v5.0 // Portfolio Simulator</span>
          <span suppressHydrationWarning className="tabular-nums">{new Date().toISOString()}</span>
        </footer>
      </div>
    </div>
  );
}
