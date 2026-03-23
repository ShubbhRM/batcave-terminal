import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') || 'SPY';

  try {
    // ── Market open check ───────────────────────────────────────────────────
    const now    = new Date();
    const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = estNow.getHours(), m = estNow.getMinutes();
    const isWeekend   = estNow.getDay() === 0 || estNow.getDay() === 6;
    const afterOpen   = h > 9 || (h === 9 && m >= 30);
    const beforeClose = h < 16;
    const isMarketOpen = !isWeekend && afterOpen && beforeClose;

    // ── Parallel fetch: daily history (for features) + 5m (for live price) ─
    // Training uses 2y of daily data → we match that here so feature vectors
    // are on the same distribution the model was trained on.
    const [featureRes, priceRes] = await Promise.all([
      fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2y`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' }
      ),
      fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' }
      ),
    ]);

    if (!featureRes.ok) throw new Error(`Yahoo API returned ${featureRes.status} for daily data`);

    // ── Parse daily bars ────────────────────────────────────────────────────
    const featureJson   = await featureRes.json();
    const featureResult = featureJson.chart?.result?.[0];
    if (!featureResult?.timestamp) throw new Error('Invalid format from Yahoo API (daily)');

    const fq        = featureResult.indicators.quote[0];
    const dailyBars = featureResult.timestamp
      .map((ts: number, i: number) => ({
        date:   new Date(ts * 1000).toISOString(),
        open:   fq.open[i],
        high:   fq.high[i],
        low:    fq.low[i],
        close:  fq.close[i],
        volume: fq.volume[i],
      }))
      .filter((bar: any) => bar.close !== null && bar.volume !== null);

    // ── Live price from most recent 5m bar ──────────────────────────────────
    // Falls back to latest daily close if intraday fetch fails (e.g. weekend).
    let livePrice: number = dailyBars[dailyBars.length - 1].close;
    if (priceRes.ok) {
      try {
        const priceJson   = await priceRes.json();
        const priceResult = priceJson.chart?.result?.[0];
        const pq          = priceResult?.indicators?.quote?.[0];
        const closes      = pq?.close?.filter((c: number | null) => c !== null) ?? [];
        if (closes.length > 0) livePrice = closes[closes.length - 1];
      } catch {
        // silent fallback to daily close
      }
    }

    return NextResponse.json({
      symbol,
      marketOpen: isMarketOpen,
      data:       dailyBars,   // daily bars — use for feature extraction
      livePrice,               // latest intraday price for display
      timestamp:  new Date().toISOString(),
    });

  } catch (error: any) {
    console.error('market-data error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
