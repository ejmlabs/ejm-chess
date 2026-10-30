# Specialty Wrangler examples

Unarmed, non-secret templates for the five gitignored specialty configs.
They are not deployable production candidates.

## Copy into the product root

```bash
cp config-examples/wrangler.capacity.example.jsonc wrangler.capacity.jsonc
cp config-examples/wrangler.proof-service.example.jsonc wrangler.proof-service.jsonc
cp config-examples/wrangler.proof-qualification.example.jsonc wrangler.proof-qualification.jsonc
cp config-examples/wrangler.proof-acceptance.example.jsonc wrangler.proof-acceptance.jsonc
cp config-examples/wrangler.recovery-drill.example.jsonc wrangler.recovery-drill.jsonc
```

Then replace placeholders from the private provider inventory. Keep real account
IDs, namespace IDs, database IDs, tokens, Container digests and hostnames out of
Git. The copied files stay gitignored.

## Per-file purpose

| Example | Becomes | Use |
| --- | --- | --- |
| `wrangler.capacity.example.jsonc` | `wrangler.capacity.jsonc` | Exact unsealed capacity seal contract; fill IDs only in a private seal review |
| `wrangler.proof-service.example.jsonc` | `wrangler.proof-service.jsonc` | Private `TimeoutProver` Worker; add Container after tier qualification |
| `wrangler.proof-qualification.example.jsonc` | `wrangler.proof-qualification.jsonc` | Isolated fixed-corpus harness; needs fresh non-production D1 and namespaces |
| `wrangler.proof-acceptance.example.jsonc` | `wrangler.proof-acceptance.jsonc` | Control-only acceptance journal; stays unarmed until a reviewed seal |
| `wrangler.recovery-drill.example.jsonc` | `wrangler.recovery-drill.jsonc` | Isolated recovery/privacy drill Worker for Vitest and provider drills |

See [source handoff](../docs/source-handoff.md), [timeout proofs](../docs/timeout-proofs.md),
[recovery drill](../docs/recovery-drill.md) and [capacity qualification](../docs/capacity-qualification.md).
