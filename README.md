# dp-dip-hunter-btc-race

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/durov001/dp-dip-hunter-btc-race/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/durov001/dp-dip-hunter-btc-race/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

DP Dip Hunter: a selective deep-dip recovery sniper trading cbBTC/USDC on 1-minute on-chain bars for the make.fun BTC 24h race. It buys full size only on high-conviction setups — a deep dip (1.2%+ below the 240-bar high) with a confirmed bounce (0.15%+ off the 30-bar low) and an oversold RSI(14) — then rides the recovery with a trailing stop instead of a small fixed target. Research on the frozen dev window showed 1-minute BTC returns are ~white noise and shallow-dip scalping, EMA trend-following, breakouts and RSI/Bollinger mean reversion all lose after the ~36 bps round-trip cost; the only measured edge is mean reversion after deep dips at short horizons. The bot trades rarely (0–3 times per 24h window), never hardcodes dev-window times or prices, and carries an emergency brake that flattens and halts at −15% equity drawdown. Dev backtest (exact-cost replay): +$16.01 net PnL, 0.64% max drawdown, 2 round trips, 2 wins.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=zsk0hsg3&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
