'use client';

import { useEffect, useState, useCallback, FormEvent } from 'react';
import {
  ShieldAlert, Activity, Clock, RefreshCw, Play,
  RotateCcw, BarChart2, ChevronLeft, Zap, AlertTriangle,
} from 'lucide-react';
import clsx from 'clsx';

// ─── Types ────────────────────────────────────────────────────────────────────
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

interface LiveMetrics {
  portfolioValue: number;
  pnl:            number;
  pnlPct:         number;
  benchmarkValue: number;
  benchmarkReturn:number;
  alpha:          number;
  maxDrawdown:    number;
  daysSince:      number;
  livePrices:     Record<string, number>;
}

interface PaperData {
  active:       boolean;
  startDate:    string;
  lastUpdate:   string | null;
  startCapital: number;
  assets:       string[];
  holdings:     Record<string, { shares: number }>;
  trades:       PaperTrade[];
  snapshots:    PaperSnapshot[];
  live:         LiveMetrics;
}

// ─── Equity Curve ─────────────────────────────────────────────────────────────
function EquityCurve({ snapshots, startCapital }: {
  snapshots:    PaperSnapshot[];
  startCapital: number;
}) {
  if (snapshots.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-emerald-500">
        <Activity className="w-8 h-8 opacity-30" />
        <span className="text-sm tracking-widest uppercase">
          Awaiting Snapshots — Hit Update Now To Begin Recording
        </span>
      </div>
    );
  }

  const W = 800, H = 210;
  const pad = { top: 20, right: 24, bottom: 36, left: 68 };
  const cW  = W - pad.left - pad.right;
  const cH  = H - pad.top  - pad.bottom;
  const n   = snapshots.length;

  const allVals = snapshots.flatMap(s => [s.portfolioValue, s.benchmarkValue]);
  const rawMin  = Math.min(...allVals);
  const rawMax  = Math.max(...allVals);
  const pad5    = (rawMax - rawMin) * 0.06 || 100;
  const minV    = rawMin - pad5;
  const maxV    = rawMax + pad5;
  const range   = maxV - minV;

  const xS = (i: number) => pad.left + (i / (n - 1)) * cW;
  const yS = (v: number) => pad.top  + cH - ((v - minV) / range) * cH;

  const portPts  = snapshots.map((s, i) => `${xS(i)},${yS(s.portfolioValue)}`).join(' ');
  const benchPts = snapshots.map((s, i) => `${xS(i)},${yS(s.benchmarkValue)}`).join(' ');
  const endX     = xS(n - 1);
  const baseY    = yS(minV);
  const startY   = yS(startCapital);

  // Gridlines
  const gridLines = Array.from({ length: 5 }, (_, i) => minV + (i / 4) * range);

  // Date helpers
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const midIdx  = Math.floor(n / 2);
  const midDate = n > 5 ? fmt(snapshots[midIdx].date) : null;

  // Dollar label formatter
  const money = (v: number) =>
    v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M`
    : v >= 1_000   ? `$${(v / 1_000).toFixed(1)}k`
    : `$${v.toFixed(0)}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: '220px' }}>
      <defs>
        <filter id="ec-glow">
          <feGaussianBlur stdDeviation="2.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <linearGradient id="ec-port-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="rgba(16,185,129,0.28)" />
          <stop offset="100%" stopColor="rgba(16,185,129,0.01)" />
        </linearGradient>
        <linearGradient id="ec-bench-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="rgba(59,130,246,0.12)" />
          <stop offset="100%" stopColor="rgba(59,130,246,0.01)" />
        </linearGradient>
      </defs>

      {/* Grid lines + Y labels */}
      {gridLines.map((v, i) => {
        const y = yS(v);
        return (
          <g key={i}>
            <line x1={pad.left} y1={y} x2={W - pad.right} y2={y}
              stroke="rgba(16,185,129,0.07)" strokeWidth="1" />
            <text x={pad.left - 8} y={y} textAnchor="end" fontSize="9"
              fill="rgba(16,185,129,0.35)" fontFamily="monospace" dominantBaseline="middle">
              {money(v)}
            </text>
          </g>
        );
      })}

      {/* Start capital baseline */}
      <line x1={pad.left} y1={startY} x2={W - pad.right} y2={startY}
        stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="3 4" />

      {/* Area fills */}
      <polygon
        points={`${xS(0)},${baseY} ${benchPts} ${endX},${baseY}`}
        fill="url(#ec-bench-fill)" />
      <polygon
        points={`${xS(0)},${baseY} ${portPts}  ${endX},${baseY}`}
        fill="url(#ec-port-fill)" />

      {/* Benchmark line (dashed blue) */}
      <polyline points={benchPts} fill="none"
        stroke="rgba(59,130,246,0.55)" strokeWidth="1.5" strokeDasharray="5 3" />

      {/* Portfolio line */}
      <polyline points={portPts} fill="none"
        stroke="#10b981" strokeWidth="2.5" filter="url(#ec-glow)" />

      {/* End dot */}
      <circle cx={endX} cy={yS(snapshots[n - 1].portfolioValue)} r="4"
        fill="#10b981" filter="url(#ec-glow)" />

      {/* X-axis date labels */}
      <text x={pad.left}          y={H - 6} fontSize="9" fill="rgba(16,185,129,0.4)" fontFamily="monospace">
        {fmt(snapshots[0].date)}
      </text>
      {midDate && (
        <text x={W / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="rgba(16,185,129,0.28)" fontFamily="monospace">
          {midDate}
        </text>
      )}
      <text x={W - pad.right} y={H - 6} textAnchor="end" fontSize="9" fill="rgba(16,185,129,0.4)" fontFamily="monospace">
        {fmt(snapshots[n - 1].date)}
      </text>

      {/* Legend */}
      <line x1={W - 175} y1={pad.top + 8}  x2={W - 152} y2={pad.top + 8}  stroke="#10b981" strokeWidth="2.5" />
      <text x={W - 148}  y={pad.top + 12}  fontSize="9" fill="rgba(16,185,129,0.7)" fontFamily="monospace">PORTFOLIO</text>
      <line x1={W - 175} y1={pad.top + 24} x2={W - 152} y2={pad.top + 24}
        stroke="rgba(59,130,246,0.6)" strokeWidth="1.5" strokeDasharray="5 3" />
      <text x={W - 148}  y={pad.top + 28}  fontSize="9" fill="rgba(59,130,246,0.6)" fontFamily="monospace">SPY B&amp;H</text>
    </svg>
  );
}

// ─── Metric Card ──────────────────────────────────────────────────────────────
function MetricCard({ label, value, sub, positive, neutral = false }: {
  label:     string;
  value:     string;
  sub?:      string;
  positive?: boolean;
  neutral?:  boolean;
}) {
  const color = neutral ? '#10b981' : positive ? '#10b981' : '#ef4444';
  return (
    <div className="border border-emerald-800/40 bg-[#060d09] rounded-lg p-5 card-tactical animate-slide-up">
      <div className="text-xs tracking-[0.18em] uppercase text-emerald-500 mb-3">{label}</div>
      <div className="text-3xl font-bold tabular-nums leading-none"
        style={{ color, textShadow: `0 0 18px ${color}40` }}>
        {value}
      </div>
      {sub && <div className="text-sm text-emerald-500 mt-2">{sub}</div>}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function PaperPage() {
  const [data,      setData]      = useState<PaperData | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [updating,  setUpdating]  = useState(false);
  const [showInit,  setShowInit]  = useState(false);
  const [capital,   setCapital]   = useState('10000');
  const [assets,    setAssets]    = useState('SPY,QQQ,AAPL,TSLA,BTC-USD');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // ── Fetch ────────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      const res  = await fetch('/api/paper');
      const json = await res.json() as PaperData;
      setData(json);
      if (!json.active) setShowInit(true);
    } catch (e) {
      console.error('Paper fetch error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Update ───────────────────────────────────────────────────────────────────
  const handleUpdate = async () => {
    setUpdating(true);
    setStatusMsg(null);
    try {
      const res  = await fetch('/api/paper', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'update' }),
      });
      const json = await res.json();
      if (json.ok) {
        setStatusMsg(
          `Updated — ${json.trades?.length ?? 0} trade(s) executed · snapshot #${json.snapshotCount}`
        );
        await fetchData();
      } else {
        setStatusMsg(`Error: ${json.error}`);
      }
    } finally {
      setUpdating(false);
    }
  };

  // ── Init ─────────────────────────────────────────────────────────────────────
  const handleInit = async (e: FormEvent) => {
    e.preventDefault();
    const assetList = assets.split(',').map(s => s.trim()).filter(Boolean);
    setUpdating(true);
    setStatusMsg(null);
    try {
      const res  = await fetch('/api/paper', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'init', capital: parseFloat(capital), assets: assetList }),
      });
      const json = await res.json();
      if (json.ok) {
        setShowInit(false);
        setStatusMsg(`Session initialised · assets: ${(json.assets as string[]).join(', ')}`);
        await fetchData();
      } else {
        setStatusMsg(`Error: ${json.error}`);
      }
    } finally {
      setUpdating(false);
    }
  };

  // ── Reset ────────────────────────────────────────────────────────────────────
  const handleReset = async () => {
    if (!window.confirm('Clear current session? This cannot be undone.')) return;
    await fetch('/api/paper', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'reset' }),
    });
    setData(null);
    setShowInit(true);
    setStatusMsg('Session cleared.');
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const fmt = (n: number, d = 2) =>
    n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  const fmtDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const fmtTime = (d: string) =>
    new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const regColor = (w?: { momentum: number; meanReversion: number; volume: number }) => {
    if (!w) return 'rgba(16,185,129,0.3)';
    const dom = Object.entries(w).sort(([, a], [, b]) => b - a)[0][0];
    return dom === 'momentum' ? '#10b981' : dom === 'meanReversion' ? '#f59e0b' : '#8b5cf6';
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#060d09] text-emerald-400 font-mono selection:bg-emerald-900 selection:text-emerald-300 scanlines bg-grid relative">

      {/* Scan line */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-40">
        <div className="animate-scan-line absolute w-full h-px bg-gradient-to-r from-transparent via-emerald-400/20 to-transparent" />
      </div>

      <div className="relative z-10 p-8">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-emerald-800/40 pb-7 mb-10 gap-5">
          <div className="animate-slide-up">
            <div className="flex items-center gap-3 mb-1">
              <ShieldAlert className="w-7 h-7 text-emerald-400 animate-glow-pulse" />
              <h1 className="text-2xl font-bold tracking-[0.05em] text-emerald-300 glow-emerald animate-flicker">
                PAPER EVAL
              </h1>
              <span className="text-xs border border-emerald-700/40 px-2 py-0.5 rounded text-emerald-500">
                LIVE DATA
              </span>
            </div>
            <p className="text-emerald-500 text-xs tracking-[0.25em] uppercase pl-10">
              Forward Evaluation // Real Market Prices // No Real Orders
            </p>
          </div>

          <div className="flex flex-wrap gap-3 items-center animate-slide-up delay-100">
            <a href="/"
              className="flex items-center gap-2 border border-emerald-900/40 bg-emerald-950/20 px-3 py-2 rounded text-sm text-emerald-500 hover:text-emerald-300 hover:border-emerald-700 transition-colors">
              <ChevronLeft className="w-3.5 h-3.5" /> DASHBOARD
            </a>
            <a href="/simulate"
              className="flex items-center gap-2 border border-emerald-900/40 bg-emerald-950/20 px-3 py-2 rounded text-sm text-emerald-500 hover:text-emerald-300 hover:border-emerald-700 transition-colors">
              <BarChart2 className="w-3.5 h-3.5" /> SIMULATOR
            </a>

            {data?.active && (
              <>
                <button onClick={handleUpdate} disabled={updating}
                  className="flex items-center gap-2 border border-emerald-700/50 bg-emerald-950/30 px-4 py-2 rounded text-sm text-emerald-300 hover:bg-emerald-900/30 transition-colors disabled:opacity-50">
                  <RefreshCw className={clsx('w-4 h-4', updating && 'animate-spin')} />
                  {updating ? 'UPDATING...' : 'UPDATE NOW'}
                </button>
                <button onClick={() => setShowInit(true)}
                  className="flex items-center gap-2 border border-emerald-900/40 bg-emerald-950/20 px-3 py-2 rounded text-sm text-emerald-500 hover:text-emerald-300 transition-colors">
                  <Play className="w-3.5 h-3.5" /> NEW SESSION
                </button>
              </>
            )}
          </div>
        </header>

        {/* Status message */}
        {statusMsg && (
          <div className="mb-6 px-4 py-2.5 border border-emerald-800/40 bg-emerald-950/20 rounded text-sm text-emerald-500 animate-slide-up flex items-center gap-2">
            <Zap className="w-3 h-3 shrink-0" /> {statusMsg}
          </div>
        )}

        {/* ── Loading ─────────────────────────────────────────────────────── */}
        {loading ? (
          <div className="flex justify-center items-center h-64 border border-emerald-900/20 bg-emerald-950/10 rounded-lg flex-col gap-4 text-emerald-400">
            <Activity className="w-8 h-8 animate-spin text-emerald-500" />
            <div className="text-sm tracking-widest uppercase cursor">LOADING SESSION DATA</div>
          </div>

        ) : showInit ? (
          // ── Init / New Session form ────────────────────────────────────────
          <div className="max-w-lg mx-auto animate-slide-up">
            <div className="border border-emerald-800/40 bg-emerald-950/10 rounded-xl p-8">
              <div className="text-xs tracking-[0.2em] uppercase text-emerald-500 mb-6">
                INITIALISE SESSION
              </div>
              <form onSubmit={handleInit} className="space-y-5">
                <div>
                  <label className="block text-sm text-emerald-400 mb-2 tracking-widest uppercase">
                    Starting Capital ($)
                  </label>
                  <input
                    type="number" value={capital} onChange={e => setCapital(e.target.value)}
                    className="w-full bg-[#060d09] border border-emerald-900/40 rounded px-4 py-3 text-emerald-300 text-sm focus:outline-none focus:border-emerald-600 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm text-emerald-400 mb-2 tracking-widest uppercase">
                    Assets (comma-separated, max 5)
                  </label>
                  <input
                    type="text" value={assets} onChange={e => setAssets(e.target.value)}
                    className="w-full bg-[#060d09] border border-emerald-900/40 rounded px-4 py-3 text-emerald-300 text-sm focus:outline-none focus:border-emerald-600 transition-colors"
                  />
                  <p className="text-sm text-emerald-500 mt-2">
                    Yahoo Finance tickers, e.g. SPY, QQQ, AAPL, TSLA, BTC-USD
                  </p>
                </div>
                <div className="flex gap-3 pt-2">
                  <button type="submit" disabled={updating}
                    className="flex-1 flex items-center justify-center gap-2 bg-emerald-900/30 border border-emerald-700/50 rounded px-4 py-3 text-emerald-300 text-sm hover:bg-emerald-800/30 transition-colors disabled:opacity-50">
                    <Play className="w-4 h-4" />
                    {updating ? 'INITIALISING...' : 'START SESSION'}
                  </button>
                  {data?.active && (
                    <button type="button" onClick={() => setShowInit(false)}
                      className="px-4 py-3 border border-emerald-800/40 rounded text-emerald-400 text-sm hover:text-emerald-400 transition-colors">
                      CANCEL
                    </button>
                  )}
                </div>
              </form>
            </div>

            <div className="mt-6 border border-amber-900/30 bg-amber-950/10 rounded-lg px-4 py-3 text-sm text-amber-700 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <span>
                Starting a new session <strong className="text-amber-500">replaces</strong> any existing
                session. Click <strong className="text-amber-500">Update Now</strong> regularly (daily
                recommended) to record snapshots and run inference.
              </span>
            </div>
          </div>

        ) : data?.active ? (
          // ── Live Dashboard ─────────────────────────────────────────────────
          <div className="space-y-6">

            {/* Session info bar */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-emerald-400 animate-slide-up items-center">
              <span className="flex items-center gap-1.5">
                <Clock className="w-3 h-3" />
                Started: <span className="text-emerald-400 ml-1">{fmtDate(data.startDate)}</span>
              </span>
              <span className="text-emerald-500">·</span>
              <span>
                Capital: <span className="text-emerald-400">${fmt(data.startCapital)}</span>
              </span>
              <span className="text-emerald-500">·</span>
              <span>
                Last Update:{' '}
                <span className="text-emerald-400">
                  {data.lastUpdate ? fmtTime(data.lastUpdate) : 'Never'}
                </span>
              </span>
              <span className="text-emerald-500">·</span>
              <span>
                Snapshots: <span className="text-emerald-400">{data.snapshots.length}</span>
              </span>
              <span className="ml-auto">
                <button onClick={handleReset}
                  className="flex items-center gap-1 text-red-900 hover:text-red-600 transition-colors">
                  <RotateCcw className="w-3 h-3" /> RESET
                </button>
              </span>
            </div>

            {/* ── Metric cards ────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
              <MetricCard
                label="Total Return"
                value={`${data.live.pnlPct >= 0 ? '+' : ''}${fmt(data.live.pnlPct)}%`}
                sub={`P&L: $${fmt(data.live.pnl)}`}
                positive={data.live.pnlPct >= 0}
              />
              <MetricCard
                label="SPY B&H"
                value={`${data.live.benchmarkReturn >= 0 ? '+' : ''}${fmt(data.live.benchmarkReturn)}%`}
                sub={`$${fmt(data.live.benchmarkValue)}`}
                positive={data.live.benchmarkReturn >= 0}
              />
              <MetricCard
                label="Alpha"
                value={`${data.live.alpha >= 0 ? '+' : ''}${fmt(data.live.alpha)}%`}
                sub={data.live.alpha >= 0 ? 'Outperforming SPY' : 'Underperforming SPY'}
                positive={data.live.alpha >= 0}
              />
              <MetricCard
                label="Max Drawdown"
                value={`-${fmt(data.live.maxDrawdown)}%`}
                sub="Peak → Trough"
                positive={false}
                neutral={data.live.maxDrawdown < 5}
              />
              <MetricCard
                label="Days Active"
                value={String(data.live.daysSince)}
                sub={`${data.trades.length} trade(s)`}
                neutral
              />
            </div>

            {/* ── Equity Curve ─────────────────────────────────────────────── */}
            <div className="border border-emerald-800/40 bg-[#060d09] rounded-xl p-7 card-tactical animate-slide-up delay-100">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="text-xs tracking-[0.2em] uppercase text-emerald-400 mb-1">
                    EQUITY CURVE
                  </div>
                  <div className="flex items-baseline gap-3">
                    <span className="text-emerald-300 font-bold text-xl tabular-nums">
                      ${fmt(data.live.portfolioValue)}
                    </span>
                    <span className={clsx(
                      'text-sm font-bold tabular-nums',
                      data.live.pnlPct >= 0 ? 'text-emerald-500' : 'text-red-500'
                    )}>
                      {data.live.pnlPct >= 0 ? '+' : ''}{fmt(data.live.pnlPct)}%
                    </span>
                  </div>
                </div>
                <div className="text-right text-sm text-emerald-500 space-y-1">
                  <div className="flex items-center justify-end gap-2">
                    <span className="inline-block w-5 h-0.5 bg-emerald-400 rounded" />
                    <span>Portfolio</span>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <span className="inline-block w-5 border-t border-dashed border-blue-500/60" />
                    <span>SPY B&H</span>
                  </div>
                </div>
              </div>
              <EquityCurve snapshots={data.snapshots} startCapital={data.startCapital} />
            </div>

            {/* ── Positions + Trades ───────────────────────────────────────── */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

              {/* Current positions */}
              <div className="border border-emerald-800/40 bg-[#060d09] rounded-xl p-7 card-tactical animate-slide-up delay-200">
                <div className="text-xs tracking-[0.2em] uppercase text-emerald-400 mb-5">
                  CURRENT POSITIONS
                </div>
                <div className="space-y-1">
                  {data.assets.map(sym => {
                    const h        = data.holdings[sym];
                    const price    = data.live.livePrices[sym] ?? 0;
                    const val      = (h?.shares ?? 0) * price;
                    const initVal  = data.startCapital / data.assets.length;
                    const pnlPct   = initVal > 0 ? ((val - initVal) / initVal) * 100 : 0;
                    const lastSnap = data.snapshots[data.snapshots.length - 1];
                    const wt       = lastSnap?.weights?.[sym];
                    const rc       = regColor(wt);

                    return (
                      <div key={sym}
                        className="flex items-center justify-between py-3 border-b border-emerald-900/15 last:border-0">
                        <div className="flex items-center gap-3">
                          {/* Regime colour accent */}
                          <div className="w-1 h-9 rounded-full shrink-0" style={{ backgroundColor: rc }} />
                          <div>
                            <div className="text-sm font-bold text-emerald-300">{sym}</div>
                            <div className="text-sm text-emerald-400">
                              {(h?.shares ?? 0).toFixed(4)} sh · ${fmt(price)}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-bold tabular-nums text-emerald-300">
                            ${fmt(val)}
                          </div>
                          <div className={clsx(
                            'text-xs tabular-nums',
                            pnlPct >= 0 ? 'text-emerald-500' : 'text-red-500'
                          )}>
                            {pnlPct >= 0 ? '+' : ''}{fmt(pnlPct)}%
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* Portfolio total row */}
                  <div className="flex items-center justify-between pt-3 mt-1 border-t border-emerald-800/40">
                    <span className="text-sm tracking-widest text-emerald-400 uppercase">TOTAL</span>
                    <div className="text-right">
                      <div className="text-base font-bold tabular-nums text-emerald-300">
                        ${fmt(data.live.portfolioValue)}
                      </div>
                      <div className={clsx(
                        'text-xs tabular-nums',
                        data.live.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                      )}>
                        {data.live.pnlPct >= 0 ? '+' : ''}{fmt(data.live.pnlPct)}%
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Trade log */}
              <div className="border border-emerald-800/40 bg-[#060d09] rounded-xl p-7 card-tactical animate-slide-up delay-300">
                <div className="text-xs tracking-[0.2em] uppercase text-emerald-400 mb-5 flex items-baseline gap-2">
                  TRADE LOG
                  <span className="text-emerald-500 font-normal normal-case">
                    ({data.trades.length} total)
                  </span>
                </div>

                {data.trades.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 gap-3 text-emerald-500">
                    <Activity className="w-7 h-7 opacity-30" />
                    <span className="text-sm tracking-widest">
                      No trades yet — hit Update Now to run first inference
                    </span>
                  </div>
                ) : (
                  <div className="space-y-0.5 max-h-72 overflow-y-auto pr-1">
                    {/* Most recent first */}
                    {[...data.trades].reverse().slice(0, 30).map((t, i) => {
                      const ac =
                        t.action === 'BUY'       ? '#10b981'
                        : t.action === 'SELL'     ? '#ef4444'
                        : '#f59e0b';
                      return (
                        <div key={i}
                          className="flex items-center justify-between py-2 border-b border-emerald-900/10 last:border-0 text-xs">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-bold w-16 shrink-0" style={{ color: ac }}>
                              {t.action}
                            </span>
                            <span className="text-emerald-300 shrink-0">{t.asset}</span>
                            <span className="text-emerald-500 truncate">
                              {t.shares.toFixed(4)} sh
                            </span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0 ml-2">
                            <span className="text-emerald-500">${fmt(t.price)}</span>
                            <span className="text-emerald-500 w-20 text-right">
                              {new Date(t.date).toLocaleDateString('en-US', {
                                month: 'short', day: 'numeric',
                              })}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="mt-20 border-t border-emerald-900/20 pt-6 text-sm text-emerald-500/60 flex justify-between items-center">
          <span>BATCAVE TERMINAL v5.0 // PAPER EVAL ENGINE // FORWARD INFERENCE</span>
          <span className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-700 animate-pulse-dot" />
            EDGE NODE ACTIVE
          </span>
        </footer>
      </div>
    </div>
  );
}
