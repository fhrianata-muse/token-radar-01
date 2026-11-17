# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/fhrianata-muse/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/fhrianata-muse/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

LaunchScope — a token launch radar over one sealed DefiLlama snapshot (758 protocols, as of 2026-11-14). It ranks 167 pre-token protocols — all 40 of the snapshot's watchlist plus the early radar below its $50M floor, down to $10M TVL — by implied launch value, each with a per-category farm plan whose steps carry explicit costs and times.

The model (radar-2) is a power law, implied = exp(a) × TVL^b, fitted by OLS on log-log over the snapshot's 128 live-token protocols, times a shrunk category offset (log space, k=8, clamped ±0.35), a growth factor on the 7-day TVL change (weight 0.25) and a maturity factor for years run without a token (0.85–1.00). It was not picked by taste: every candidate — the flat 0.25 multiple, global and category medians, the starter model — was scored by leave-one-out against the live protocols' real market caps, and radar-2 measured lowest (mean |log10 error| 0.6867, median fold 3.61, vs 0.7680 / 4.91 for the flat multiple). The dashboard renders that validation table, the category multiples and the calibration set from the same data it ranks, and shows each protocol's full pricing breakdown and range. Implied values are the model's claims from the snapshot's own figures, not predictions that a launch will happen.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

With no /input mounted, point --input at any copy of the snapshot: `node main.ts --input ../input/snapshot.json`. The program writes board.json, data.js, dashboard/, screenshots/ and dossier.json into the output directory. To view the dashboard, serve the output directory and open dashboard/ in a browser.

---

<sub>Entered on [make.fun](https://make.fun/?ref=q4engdna&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
