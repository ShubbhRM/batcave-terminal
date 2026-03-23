'use client';

import { useEffect, useState, useRef, FormEvent } from 'react';
import {
  ShieldAlert, Search, BarChart2, Activity,
  AlertTriangle, TrendingUp, ArrowLeftRight, Volume2, Zap,
} from 'lucide-react';
import clsx from 'clsx';

// ─── Types ────────────────────────────────────────────────────────────────────
interface SignalData {
  symbol:     string;
  price:      number;
  marketOpen: boolean;
  weights: {
    momentum:      number;
    meanReversion: number;
    volume:        number;
  };
  timestamp: string;
}

// ─── Arc Gauge ────────────────────────────────────────────────────────────────
function ArcGauge({ value, color }: { value: number; color: string }) {
  const R    = 38;
  const cx   = 48, cy = 48;
  const circ = 2 * Math.PI * R;
  const arc  = circ * 0.75;
  const fill = value * arc;

  return (
    <svg width="96" height="84" viewBox="0 0 96 84" className="shrink-0">
      <circle cx={cx} cy={cy} r={R} fill="none"
        stroke="rgba(255,255,255,0.06)" strokeWidth="5"
        strokeDasharray={`${arc} ${circ - arc}`}
        transform={`rotate(135 ${cx} ${cy})`} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={R} fill="none"
        stroke={color} strokeWidth="5"
        strokeDasharray={`${fill} ${circ - fill}`}
        transform={`rotate(135 ${cx} ${cy})`} strokeLinecap="round"
        style={{
          filter: `drop-shadow(0 0 5px ${color}80)`,
          transition: 'stroke-dasharray 1.1s cubic-bezier(0.4,0,0.2,1)',
        }} />
      <text x={cx} y={cy - 5} textAnchor="middle" fontSize="15" fontWeight="700"
        fill={color} fontFamily="var(--font-geist-mono)" dominantBaseline="middle">
        {(value * 100).toFixed(0)}
      </text>
      <text x={cx} y={cy + 11} textAnchor="middle" fontSize="9"
        fill={color} fontFamily="var(--font-geist-mono)" opacity="0.55">%</text>
    </svg>
  );
}

// ─── Expert definitions ───────────────────────────────────────────────────────
const EXPERTS = [
  {
    key:   'momentum'      as const,
    label: 'Momentum',
    color: '#10b981',
    Icon:  TrendingUp,
    desc:  'SMA crossovers, ROC breakouts. Dominant in trending markets.',
  },
  {
    key:   'meanReversion' as const,
    label: 'Mean Reversion',
    color: '#f59e0b',
    Icon:  ArrowLeftRight,
    desc:  'RSI extrema, Bollinger Z-scores. Dominant in ranging markets.',
  },
  {
    key:   'volume'        as const,
    label: 'Volume Flow',
    color: '#8b5cf6',
    Icon:  Volume2,
    desc:  'OBV divergence, VWAP deviation. Detects institutional flow.',
  },
] as const;

// ─── Expert Card ──────────────────────────────────────────────────────────────
function ExpertCard({
  expert, value, delay,
}: {
  expert: typeof EXPERTS[number];
  value:  number;
  delay:  number;
}) {
  const { label, color, Icon, desc } = expert;
  return (
    <div
      className="card animate-slide-up rounded-xl border border-slate-800 bg-slate-950 p-6 flex flex-col gap-4"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Icon className="w-3.5 h-3.5" style={{ color }} />
            <span className="text-xs tracking-widest uppercase" style={{ color: `${color}88` }}>
              {label}
            </span>
          </div>
          <div className="text-5xl font-bold font-mono tabular-nums leading-none"
            style={{ color, textShadow: `0 0 24px ${color}40` }}>
            {(value * 100).toFixed(1)}<span className="text-2xl opacity-40">%</span>
          </div>
        </div>
        <ArcGauge value={value} color={color} />
      </div>

      <div className="h-0.5 rounded-full bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full animate-bar-grow"
          style={{ width: `${value * 100}%`, backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
      </div>

      <p className="text-xs leading-relaxed text-slate-600">{desc}</p>
    </div>
  );
}

// ─── Regime badge ─────────────────────────────────────────────────────────────
function RegimeBadge({ weights }: { weights: SignalData['weights'] }) {
  const dom = EXPERTS.slice().sort((a, b) => weights[b.key] - weights[a.key])[0];
  const actionMap = {
    momentum:      'Follow the trend',
    meanReversion: 'Buy dips · sell rips',
    volume:        'Watch OBV divergence',
  };
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border"
      style={{ borderColor: `${dom.color}22`, backgroundColor: `${dom.color}08` }}>
      <span className="w-2 h-2 rounded-full shrink-0 animate-pulse-dot"
        style={{ backgroundColor: dom.color }} />
      <div>
        <div className="text-xs tracking-widest uppercase mb-0.5"
          style={{ color: `${dom.color}77` }}>Active Regime</div>
        <div className="text-sm font-bold" style={{ color: dom.color }}>
          {dom.label.toUpperCase()} — {actionMap[dom.key]}
        </div>
      </div>
    </div>
  );
}

// ─── Allocation bars ──────────────────────────────────────────────────────────
function AllocationBars({ weights }: { weights: SignalData['weights'] }) {
  return (
    <div className="space-y-4">
      {EXPERTS.map(e => (
        <div key={e.key}>
          <div className="flex justify-between items-center mb-1.5">
            <div className="flex items-center gap-2">
              <e.Icon className="w-3 h-3" style={{ color: e.color }} />
              <span className="text-xs tracking-wide" style={{ color: `${e.color}99` }}>
                {e.label.toUpperCase()}
              </span>
            </div>
            <span className="text-xs font-bold font-mono tabular-nums" style={{ color: e.color }}>
              {(weights[e.key] * 100).toFixed(1)}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div className="h-full rounded-full animate-bar-grow"
              style={{
                width: `${weights[e.key] * 100}%`,
                backgroundColor: e.color,
                boxShadow: `0 0 8px ${e.color}60`,
              }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [data,      setData]      = useState<SignalData | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [symbol,    setSymbol]    = useState('SPY');
  const [searchVal, setSearchVal] = useState('');
  const [lastUpdate,setLastUpdate]= useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSignal = async (sym: string) => {
    try {
      setError(null);
      const res  = await fetch(`/api/signal?symbol=${sym}`);
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error ?? 'Fetch failed');
      setData(json as SignalData);
      setLastUpdate(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setData(null);
    fetchSignal(symbol);
    timerRef.current = setInterval(() => fetchSignal(symbol), 60_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [symbol]);

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();
    const v = searchVal.trim().toUpperCase();
    if (v) { setSymbol(v); setSearchVal(''); }
  };

  const isOOD = data && !['SPY', 'QQQ', 'TLT', 'GLD', 'IWM'].includes(data.symbol);

  const gridBg: React.CSSProperties = {
    backgroundImage: 'radial-gradient(circle, rgba(16,185,129,0.055) 1px, transparent 1px)',
    backgroundSize:  '28px 28px',
  };

  return (
    <div className="min-h-screen bg-black text-white" style={gridBg}>
      <div className="max-w-6xl mx-auto px-6 py-8">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="flex flex-wrap gap-4 justify-between items-center pb-8 mb-10 border-b border-slate-800 animate-slide-up">
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-6 h-6 text-emerald-400" />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold tracking-wide text-emerald-400">
                  BATCAVE TERMINAL
                </span>
                <span className="text-xs border border-slate-700 px-1.5 py-0.5 rounded text-slate-500">
                  v5.0
                </span>
              </div>
              <div className="text-xs text-slate-600 tracking-widest mt-0.5">
                HIERARCHICAL RL · 3-EXPERT LSTM ENSEMBLE · ONNX
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <form onSubmit={handleSearch} className="relative">
              <input
                type="text" value={searchVal}
                onChange={e => setSearchVal(e.target.value)}
                placeholder="Ticker…"
                className="bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 pr-9 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-emerald-700 transition-colors w-36"
              />
              <button type="submit"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-emerald-400 transition-colors">
                <Search className="w-3.5 h-3.5" />
              </button>
            </form>

            <a href="/simulate"
              className="flex items-center gap-1.5 border border-slate-700 bg-slate-900 px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-emerald-400 hover:border-slate-600 transition-colors">
              <BarChart2 className="w-3.5 h-3.5" /> SIMULATOR
            </a>

            <a href="/paper"
              className="flex items-center gap-1.5 border border-slate-700 bg-slate-900 px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-emerald-400 hover:border-slate-600 transition-colors">
              <Activity className="w-3.5 h-3.5" /> PAPER EVAL
            </a>

            <div className={clsx(
              'flex items-center gap-2 px-3 py-2 rounded-lg border text-xs',
              data?.marketOpen
                ? 'border-emerald-900 bg-emerald-950/40 text-emerald-400'
                : 'border-slate-800 bg-slate-900 text-slate-500',
            )}>
              <span className={clsx(
                'w-1.5 h-1.5 rounded-full',
                data?.marketOpen ? 'bg-emerald-400 animate-pulse-dot' : 'bg-slate-600',
              )} />
              NYSE {data?.marketOpen ? 'OPEN' : 'CLOSED'}
            </div>

            {lastUpdate && (
              <span className="text-xs text-slate-600">{lastUpdate}</span>
            )}
          </div>
        </header>

        {/* ── OOD warning ────────────────────────────────────────────────── */}
        {isOOD && (
          <div className="flex items-start gap-3 border border-amber-900/40 bg-amber-950/20 rounded-lg px-4 py-3 mb-8 text-amber-600 text-xs animate-fade-in">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
            Model trained on <strong className="text-amber-400 mx-1">SPY · QQQ · TLT · GLD · IWM</strong>.
            Weights for <strong className="text-amber-400 mx-1">{data?.symbol}</strong> are extrapolated — indicative only.
          </div>
        )}

        {/* ── States ─────────────────────────────────────────────────────── */}
        {error ? (
          <div className="flex flex-col items-center justify-center h-72 rounded-xl border border-red-900/30 bg-red-950/10 gap-4 text-red-500">
            <ShieldAlert className="w-10 h-10 opacity-50" />
            <div className="text-center">
              <div className="text-sm font-bold mb-1">INFERENCE ERROR</div>
              <div className="text-xs text-red-900 max-w-sm">{error}</div>
            </div>
            <button
              onClick={() => { setLoading(true); fetchSignal(symbol); }}
              className="text-xs border border-red-900/40 px-3 py-1.5 rounded hover:border-red-700 transition-colors">
              RETRY
            </button>
          </div>

        ) : loading ? (
          <div className="flex flex-col items-center justify-center h-72 rounded-xl border border-slate-800 bg-slate-950/50 gap-4 text-slate-600">
            <Activity className="w-8 h-8 animate-spin" />
            <div className="text-xs tracking-widest uppercase">
              Running LSTM Inference — {symbol}
            </div>
          </div>

        ) : data && (
          <div className="space-y-5 animate-fade-in">

            {/* Top row: ticker + allocation */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">

              {/* Ticker card */}
              <div className="card rounded-xl border border-slate-800 bg-slate-950 p-6 animate-slide-up">
                <div className="text-xs tracking-widest uppercase text-slate-600 mb-4">
                  Target Asset
                </div>
                <div className="text-5xl font-bold tracking-tight mb-2">{data.symbol}</div>
                <div className="text-3xl font-mono font-bold text-emerald-400 mb-6"
                  style={{ textShadow: '0 0 20px rgba(16,185,129,0.3)' }}>
                  ${data.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="space-y-2 border-t border-slate-800/60 pt-4 text-xs text-slate-600">
                  <div className="flex justify-between">
                    <span>Engine</span>
                    <span className="text-slate-400 flex items-center gap-1.5">
                      <Zap className="w-3 h-3 text-emerald-700" /> LSTM-256
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Experts</span>
                    <span className="text-slate-400">3-expert ensemble</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Refresh</span>
                    <span className="text-slate-400">every 60 s</span>
                  </div>
                </div>
              </div>

              {/* Allocation panel */}
              <div className="card md:col-span-2 rounded-xl border border-slate-800 bg-slate-950 p-6 animate-slide-up delay-100">
                <div className="text-xs tracking-widest uppercase text-slate-600 mb-6">
                  Expert Allocation
                </div>
                <AllocationBars weights={data.weights} />
                <div className="mt-6">
                  <RegimeBadge weights={data.weights} />
                </div>
              </div>
            </div>

            {/* Expert detail cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {EXPERTS.map((e, i) => (
                <ExpertCard key={e.key} expert={e} value={data.weights[e.key]} delay={(i + 2) * 100} />
              ))}
            </div>

          </div>
        )}

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="mt-16 pt-6 border-t border-slate-800 flex flex-wrap justify-between items-center gap-3 text-xs text-slate-700">
          <span>BATCAVE TERMINAL v5.0 · RecurrentPPO · Sortino Reward · 1M steps</span>
          <span className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-800 animate-pulse-dot" />
            EDGE NODE ACTIVE
          </span>
        </footer>

      </div>
    </div>
  );
}
