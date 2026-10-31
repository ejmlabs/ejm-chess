# Specialty Wrangler examples

Unarmed, non-secret templates for the two gitignored specialty configs.
They are not deployable production candidates.

## Copy into the product root

```bash
cp config-examples/wrangler.capacity.example.jsonc wrangler.capacity.jsonc
cp config-examples/wrangler.recovery-drill.example.jsonc wrangler.recovery-drill.jsonc
```

Then replace placeholders from the private provider inventory. Keep real account
IDs, namespace IDs, database IDs, tokens, Container digests and hostnames out of
Git. The copied files stay gitignored.

## Per-file purpose

| Example | Becomes | Use |
| --- | --- | --- |
| `wrangler.capacity.example.jsonc` | `wrangler.capacity.jsonc` | Exact unsealed capacity seal contract; fill IDs only in a private seal review |
| `wrangler.recovery-drill.example.jsonc` | `wrangler.recovery-drill.jsonc` | Isolated recovery/privacy drill Worker for Vitest and provider drills |

See [source handoff](../docs/source-handoff.md), [recovery drill](../docs/recovery-drill.md)
and [capacity qualification](../docs/capacity-qualification.md).
