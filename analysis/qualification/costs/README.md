# Cost arithmetic evidence

This directory supports [the cost estimate](../../../docs/cost-estimate.md).
It contains public pricing facts and hypothetical inputs, not credentials,
Cloudflare account reports, measured usage, or authorization for a load run.

- `pricing-sources.json` records official URLs, retrieval references, dates,
  rates, units, rounding, and allowance assumptions.
- `estimate.py` uses Python's standard-library decimal arithmetic. It performs
  no network calls and needs no added package.
- `estimates.json` retains every scenario input, unrounded line item, rounded
  total, current local configuration hash, and the qualification allowance gap.

From the product root, reproduce the calculation:

```sh
python3 analysis/qualification/costs/estimate.py
```

Each scenario allocates the existing $5 plan fee to chess. The first calculation
assumes the published included quantities remain available. The second charges
all modeled usage to chess, including whole-million DO rounding. Account usage,
SQL allowance pooling, taxes, and other paid services are not established here.
Neither column is an upper invoice bound. A game limit does not cap web traffic.

Inputs were chosen to show sensitivity. They are not per-game measurements.
The sustained 1,000-object calculation assumes every object remains billed
active for 30 days. Browser Stockfish does not imply server engine compute.

The local source hash can drift as other launch work proceeds. Re-run before
using a revised configuration, and attach provider usage deltas before treating
any scenario as measured operation. Full billing and regional qualification
remain open.
