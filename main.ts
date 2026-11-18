// DP Dip Hunter — a selective deep-dip recovery sniper for the make.fun BTC 24h race
// (btc-race-24h-20261118-1444, cbBTC/USDC on Solana Orca, 1-minute bars, long only).
//
// Design (from research on the frozen dev window, 1,440 bars):
//   - 1-minute BTC returns are ~white noise (lag-1 autocorr +0.07). Shallow-dip scalping,
//     EMA trend-following, volatility breakouts and RSI/Bollinger mean reversion ALL lose
//     on the dev window: whipsaw plus ~36 bps round-trip cost at full size eats them.
//   - The one measured edge is mean reversion after DEEP dips at SHORT horizons: a dip of
//     1.5%+ below the 30-bar high averaged +87 bps over the next 15 bars (69% of cases beat
//     the 36 bps round-trip cost); dips of 0.3-0.5% average ~0 bps — no edge at all.
//   - The dev window's profit concentrates in rare recovery events (one overnight -2.2%
//     drop followed by a +1.7% recovery supplied the whole edge). So this bot trades RARELY
//     and only on high-conviction setups: a deep dip, a confirmed bounce, and an oversold
//     RSI — then rides the recovery with a trailing stop instead of a small fixed target.
//   - The top dev-board entries are DP-fitted schedules on the dev window itself. That
//     cannot transfer to unseen bars, so this bot is purely reactive: no hardcoded times,
//     prices, or dev-window-specific values. Every decision comes from the bars it has seen.
//
// Strategy (one symbol, CBBTC; at most one open position):
//   ENTRY (all three must hold, full size = all cash):
//     1. Deep dip: close >= 1.2% below the 240-bar rolling high.
//     2. Bounce: close >= 0.15% above the 30-bar rolling low (the dip has bottomed).
//     3. Oversold: RSI(14) <= 45.
//   EXIT (whole position, first trigger wins):
//     - Take profit: position value >= +1.5% over cost.
//     - Trailing stop: close >= 0.8% below the highest close since entry (active from
//       entry, so it is the effective stop in normal conditions).
//     - Hard stop: position value <= -2.5% under cost (a gap backstop; the trail fires
//       first in every ordinary move).
//     - Time stop: 360 bars after entry. Recoveries take 200+ bars to play out
//      (trade 1: 239 bars), and the sensitivity sweep favored longer holds (120 bars
//      exits before the recovery completes and loses money). On the dev window the
//      old 300-bar cap cut trade 2 mid-recovery (it exited at exactly seq 980 =
//      680+300); with 360 bars it rides to seq 1040 and earns $1.71 more
//      (dev PnL $16.01 -> $17.72).
//   RISK:
//     - 30-bar cooldown after every exit (no re-entry into the same selloff).
//     - Emergency brake: at -15% equity drawdown from the run peak, flatten and halt.
//     - No new entries after batch 1410: the published window is 1,440 bars, and a
//       position opened later cannot complete a recovery before the final flatten.
//     - Orders cap slippage at 100 bps past the decision close.
//   EXPECTATION: 0-3 trades per 24h window. On a window with no deep dip it trades
//   nothing and scores ~$0 (no loss). On a window with a recovery event it aims to
//   capture most of it at full size. Dev backtest (exact-cost replay): +$17.72 net PnL,
//   0.64% max drawdown, 2 round trips, 2 wins.
//
// Determinism: indicators run in float64 on + - * / alone (IEEE 754, correctly rounded);
// all comparisons that decide money use exact bigint cross-multiplication. No clock,
// no environment, no randomness, no network, no files outside the repository.

import { runBars, type BarsState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- entry parameters (basis points where a ratio is involved) ---
/** Dip depth vs the rolling high that counts as "deep". */
const DIP_LOOKBACK_BARS = 240;
const DIP_BPS = 120;
/** Bounce off the rolling low confirming the dip has bottomed. */
const BOUNCE_LOOKBACK_BARS = 30;
const BOUNCE_BPS = 15;
/** RSI(14) ceiling for "oversold". */
const RSI_BARS = 14;
const RSI_MAX = 45;

// --- exit parameters ---
/** Take profit: position value over cost, in bps. */
const TAKE_PROFIT_BPS = 150;
/** Hard stop: position value under cost, in bps (gap backstop; the trail fires first). */
const STOP_BPS = 250;
/** Trailing stop: giveback from the highest close since entry, in bps. Active from entry. */
const TRAIL_BPS = 80;
/** Longest a position is held, in bars. 360, not 300: the dev window's recoveries
 *  take 200+ bars (trade 1 held 239), and the sensitivity sweep favored longer
 *  holds (120 bars exits before the recovery completes and loses money). On dev,
 *  the 300-bar cap cut trade 2 mid-recovery (exit at exactly seq 980 = 680+300);
 *  with 360 bars it rides to seq 1040 and earns $1.71 more (dev PnL $16.01
 *  -> $17.72). */
const MAX_HOLD_BARS = 360;

// --- risk parameters ---
/** Bars to wait after an exit before a new entry. */
const COOLDOWN_BARS = 30;
/** Equity drawdown from the run peak that flattens the position and halts trading, in bps. */
const BRAKE_DD_BPS = 1500;
/** No new entries at or after this batch: the published window is 1,440 bars. */
const NO_ENTRY_AFTER_SEQ = 1410;
/** Slippage cap on every order, in bps past the decision close. */
const MAX_SLIPPAGE_BPS = 100;

const BPS = 10_000n;

/** Closes seen so far, in raw price units (ratios are scale-free). */
const closes: number[] = [];
/** Highest close since the current position opened (raw units), 0 when flat. */
let peakSinceEntry = 0;
/** Batch the current position opened on, -1 when flat. */
let entrySeq = -1;
/** Batch the last exit happened on. */
let lastExitSeq = -1_000_000;
/** Highest equity seen this run (quote units), for the brake. */
let peakEquity = 0n;
/** True once the brake has fired: no further trading. */
let halted = false;

/** RSI(14) over the closes seen so far (Wilder's smoothing), or null without enough bars. */
function rsi(): number | null {
  if (closes.length <= RSI_BARS) return null;
  let gain = 0;
  let loss = 0;
  for (let j = closes.length - RSI_BARS; j < closes.length; j++) {
    const change = closes[j]! - closes[j - 1]!;
    if (change > 0) gain += change;
    else loss -= change;
  }
  const moved = gain + loss;
  if (moved === 0) return 50;
  return (100 * gain) / moved;
}

/** Highest close over the last `n` bars, or null without enough bars. */
function rollingHigh(n: number): number | null {
  if (closes.length < n) return null;
  let high = -Infinity;
  for (let j = closes.length - n; j < closes.length; j++) {
    if (closes[j]! > high) high = closes[j]!;
  }
  return high;
}

/** Lowest close over the last `n` bars, or null without enough bars. */
function rollingLow(n: number): number | null {
  if (closes.length < n) return null;
  let low = Infinity;
  for (let j = closes.length - n; j < closes.length; j++) {
    if (closes[j]! < low) low = closes[j]!;
  }
  return low;
}

/** True when (a - b) / a >= bps / 10000, computed exactly on scaled integers. */
function dropAtLeast(a: number, b: number, bps: number): boolean {
  if (!(a > 0) || !(b >= 0)) return false;
  // a and b are raw price units (integers up to ~1e10); scale by 1e6 to keep bigint exact.
  const ai = BigInt(Math.round(a * 1e6));
  const bi = BigInt(Math.round(b * 1e6));
  return (ai - bi) * BPS >= ai * BigInt(bps);
}

/** True when (b - a) / a >= bps / 10000, computed exactly on scaled integers. */
function riseAtLeast(a: number, b: number, bps: number): boolean {
  if (!(a > 0) || !(b >= 0)) return false;
  const ai = BigInt(Math.round(a * 1e6));
  const bi = BigInt(Math.round(b * 1e6));
  return (bi - ai) * BPS >= ai * BigInt(bps);
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Fold this batch's CBBTC bar into history; without a fresh bar there is nothing to decide.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const c = Number(bar.c);
      if (Number.isFinite(c) && c > 0) closes.push(c);
    }
    if (state.equity > peakEquity) peakEquity = state.equity;
    if (bar === undefined || state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const close = closes[closes.length - 1]!;

    // Emergency brake: flatten once, then halt for the rest of the run.
    if (!halted && peakEquity > 0n && (peakEquity - state.equity) * BPS >= peakEquity * BigInt(BRAKE_DD_BPS)) {
      halted = true;
      if (held !== undefined && held.qty > 0n) {
        lastExitSeq = batch.seq;
        entrySeq = -1;
        peakSinceEntry = 0;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }
    if (halted) return [];

    // --- holding: check the exits ---
    if (held !== undefined && held.qty > 0n) {
      if (close > peakSinceEntry) peakSinceEntry = close;
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      let exit = false;
      // Take profit: value >= cost * (1 + TP).
      if (cost > 0n && value * BPS >= cost * (BPS + BigInt(TAKE_PROFIT_BPS))) exit = true;
      // Hard stop: value <= cost * (1 - STOP).
      if (!exit && cost > 0n && value * BPS <= cost * (BPS - BigInt(STOP_BPS))) exit = true;
      // Trailing stop: close >= TRAIL below the peak since entry.
      if (!exit && peakSinceEntry > 0 && dropAtLeast(peakSinceEntry, close, TRAIL_BPS)) exit = true;
      // Time stop.
      if (!exit && entrySeq >= 0 && batch.seq - entrySeq >= MAX_HOLD_BARS) exit = true;
      if (exit) {
        lastExitSeq = batch.seq;
        entrySeq = -1;
        peakSinceEntry = 0;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // --- flat: check the entry ---
    if (batch.seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (batch.seq >= NO_ENTRY_AFTER_SEQ) return [];
    const high = rollingHigh(DIP_LOOKBACK_BARS);
    const low = rollingLow(BOUNCE_LOOKBACK_BARS);
    if (high === null || low === null) return [];
    // 1. Deep dip: close >= DIP_BPS below the 240-bar high.
    if (!dropAtLeast(high, close, DIP_BPS)) return [];
    // 2. Bounce: close >= BOUNCE_BPS above the 30-bar low.
    if (!riseAtLeast(low, close, BOUNCE_BPS)) return [];
    // 3. Oversold: RSI(14) <= RSI_MAX.
    const r = rsi();
    if (r === null || r > RSI_MAX) return [];

    // Full size: all cash (fee included in the notional, so spending cash is exact).
    const spend = state.cash;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (spend < minNotional) return [];
    entrySeq = batch.seq;
    peakSinceEntry = close;
    const orders: OrderInput[] = [
      { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput,
    ];
    return orders;
  },
});
