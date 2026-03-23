# Batcave Terminal

A trading signal dashboard that runs a trained LSTM ensemble on the server and streams the results to the browser. Three expert agents each learned a different market regime - the gating network decides which one to trust at any given moment.

**Live:** https://batcave-terminal.vercel.app

---

## What it does

**`/`** - type in a ticker, get the current expert weight distribution and live price. Refreshes every 60 seconds.

**`/simulate`** - pick a date range and a basket of assets, run a full backtest. Plays back the equity curve with a regime heatmap underneath showing which expert was dominant each day.

**`/paper`** - starts a forward paper-trading session. Hit "Update Now" each day to log a new inference snapshot and track cumulative P&L vs SPY buy-and-hold.

---

## The model

Three LSTM-256 experts trained via RecurrentPPO, each specialising in a different market condition:

| Expert | What it learned |
|--------|----------------|
| Momentum | SMA crossovers, rate-of-change breakouts - works in trends |
| Mean Reversion | RSI extrema, Bollinger Z-scores - works in ranges |
| Volume Flow | OBV divergence, VWAP deviation - picks up institutional moves |

A moderator network sits on top and outputs a softmax weight vector across the three experts. It learned when each one is reliable. The 10 input features per bar are: log return, volume ratio, RSI-14, MACD signal, Bollinger %B, ATR, OBV normalised, plus a few derived momentum terms. Lookback is 60 bars.

Training: Sortino ratio as reward, 1M environment steps on SPY/QQQ/TLT/GLD/IWM daily bars.

The model is exported as a single ONNX file (~1.3 MB, weights inline) and runs server-side via `onnxruntime-web`'s WASM backend - no native binaries needed on Vercel.

---

## Stack

- Next.js 16 App Router
- `onnxruntime-web` - ONNX inference in Node.js (WASM)
- Tailwind CSS v4
- Market data via Yahoo Finance
- Deployed on Vercel

---

## Running locally

```bash
git clone https://github.com/ShubbhRM/batcave-terminal.git
cd batcave-terminal
npm install
npm run dev
```

---

## Structure

```
src/app/
├── page.tsx                  # live dashboard
├── simulate/page.tsx         # backtest replay
├── paper/page.tsx            # paper trading
└── api/
    ├── signal/route.ts       # GET /api/signal?symbol=SPY
    ├── simulate/route.ts     # POST /api/simulate
    ├── paper/route.ts        # GET|POST /api/paper
    └── market-data/route.ts  # Yahoo Finance proxy

public/
└── hierarchical_moderator.onnx
```

---

MIT
