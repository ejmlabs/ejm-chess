# Specialty Wrangler examples

Unarmed, non-secret template for the gitignored recovery-drill config.
It is not a deployable production candidate.

## Copy into the product root

```bash
cp config-examples/wrangler.recovery-drill.example.jsonc wrangler.recovery-drill.jsonc
```

Then replace placeholders from the private provider inventory. Keep real account
IDs, namespace IDs, database IDs, tokens and hostnames out of Git. The copied files stay gitignored.

## Purpose

`wrangler.recovery-drill.example.jsonc` becomes `wrangler.recovery-drill.jsonc`, the
isolated recovery/privacy drill Worker for Vitest and provider drills. The
canonical host in `AUTH_BASE_URL` only names the origin; the drill Worker has no
route or custom domain. It is reachable only at its own
`ejm-chess-recovery-drill.<account>.workers.dev` host (`workers_dev` true, preview
URLs off), which `scripts/recovery-drill.mjs` requires. The production Worker keeps
`workers_dev=false`. Set it to false and redeploy when the drill ends.

See [source handoff](../docs/source-handoff.md) and [recovery drill](../docs/recovery-drill.md).
