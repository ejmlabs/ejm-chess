# Reviewed planning baseline verification

Date: 2026-10-20. Scope: chess prerequisite 1.2. No runtime or provider change.

## Review and source contexts

Root reviewed and approved the exact prerequisite additions and narrow chess
proposal/design refresh before application and merge proof. Current source
contains only the approved paragraph refresh and this repair's evidence. The
richer main specs remain unchanged. Root owns task states and later integration,
sync, and archive.

| Context | Identity and evidence |
| --- | --- |
| GitHub main read on 2026-10-20 | `c92a4a0df2944e6ac6c22498ad4d132f0518d569`; complete, untruncated tree has only `openspec/specs/.gitkeep` and no archived copies of the three targets |
| Local main | `ef549ada7d4ecb3440d5859a4752812418465fc4`; all three current main-spec files match this commit |
| Main-spec introduction | `3917ca01886280c93795c84126084c32a4415aad` |
| Dated publication record | `../rebuild-on-ejm-ui/site-publication-2026-10-20.md` names studio source `caa4ec7f23fb80792e7a4afdb5fc4f8a28a86cea` and shared UI `69cbd4f83e816e613d54a09bf012fd8f2b61bf49` |
| Remote planning PR at review | `https://github.com/ejmlabs/ejmlabs/pull/14`, base `c92a4a0`, head `1c458be605d0a3cade60b339df50af68e6cb5fcc`, open and blocked |

The dated publication record is not a fresh provider read. It records no Git
push. Remote source history, accepted local migration, and deployment evidence
remain distinct. The older GitHub studio HTML does not implement the published
migration contract. This source difference does not block independent chess
runtime checks.

## Exact prerequisite additions

`reviewed-prerequisite-additions.patch` is an addition-only patch for the three
absent GitHub paths. It must not replace richer existing local main specs.
It contains 3,607 content bytes in three files, with the complete four existing
requirement blocks and their nine scenarios. Purpose text labels the bounded
baseline record. No runtime source is included.

| Target path under `openspec/specs/` | Complete local requirement blocks |
| --- | --- |
| `ejmlabs-site/spec.md` | Home page |
| `documentation-discovery/spec.md` | Direct guide links |
| `public-web-access/spec.md` | Worldwide public access; Public production entry points retain edge protection |

Patch SHA-256:
`425d476a5787be6f878e55b05389200a1eaf8278c8a75551970f7c29f2efca9c`.

The current chess MODIFIED blocks retain all nine prior scenario names and add
four chess scenarios. Two prior scenario bodies retain the existing three
project links and six guides while adding chess. Whole-block review found no
need to force an edit to current chess delta wording.

The approved planning refresh changes only one proposal paragraph and the first
and last paragraphs of the design's Planning baseline prerequisite section.
Its patch SHA-256 is
`0f575de3ca3569c10312923d65a8e0dfe4bde4941e74a53d0f43998f03eeaf13`.

## Actual installed-tool merge proof

The installed OpenSpec CLI ran in two disposable copies of the existing
planning root. No new project was initialized. The minimal copy replaced only
its disposable main-spec tree with the reviewed prerequisites; the rich copy
retained all current local main specs. Both copied the full current chess change.

For each copy, root selection, status, archive instructions, and specification
rules were checked before `openspec archive add-cloudflare-chess --yes --json`.
Strict change validation ran before this command, and strict main-spec
validation ran after it. Neither `--skip-specs` nor `--no-validate` was used.
Only the disposable copies were archived. This proves the merger, not completion
of the source change's unchecked release tasks.

| Proof | Result |
| --- | --- |
| Reviewed remote-minimal prerequisites | Actual merger passed; 47 added requirements, 4 modified; strict merged-spec validation passed |
| Richer current local main | Same actual merger and validation passed; all unrelated requirement blocks and unaffected main-spec files preserved |
| Existing Purpose sections | Unchanged in both copies |
| Existing scenarios | All nine retained; modified blocks match the full current delta |
| Resulting main-spec structure | Canonical requirement/scenario headings; no delta operation headings |
| Live source preservation | Three main-spec file hashes unchanged; neither live change moved or archived |

## Current-source checks

- `openspec validate add-cloudflare-chess --strict --json`: passed.
- `openspec validate reconcile-chess-planning-baseline --strict --json`: passed.
- Whitespace checks against the exact proposal/design before snapshots: passed.
- Reverse application check of the approved planning refresh: passed.
- Whole-repository `git diff --check` found an unrelated extra EOF blank line
  in `design-kit/web/CONTAINERLESS.md:201`. It was preserved.

The local main-spec SHA-256 values remain:

| Capability | SHA-256 |
| --- | --- |
| ejmlabs-site | `8e29917d9d6cc2729ef3eae7b54f654291c48f1bc1dbf44a395aefd891768b22` |
| documentation-discovery | `8d214cf9f4fe2702bf864e4605d36d9c82bcb4bba06f4fc86fe2e3983f699835` |
| public-web-access | `f0a678bb8993fe8ecc23d8289d8f2f4942dd6cebfa3b777ee3fe43507d8f42cc` |

## Evidence and remaining work

Full source snapshots, before/after hashes, relative patches, complete remote
tree, dated publication record, copied roots, command logs, and merge
comparisons are retained at:

`ejm-chess-launch-baseline-20261020-v1/`.

Start with `review/manifest.json`, `proof/live-refresh-application.json`,
`proof/merge-proof-summary.json`, `proof/remote-minimal-verification.json`,
`proof/local-rich-verification.json`, and `proof/live-checks.json`.

The reviewed baseline patch has not been applied or pushed to remote main.
Neither live change is synced or archived here. Root decides the proper remote
integration and task states. Product, guides, studio discovery, provider,
capacity, email, and full-service recovery gates remain separate.

This change affects planning provenance only. Public product docs need no
update. No public page, dependency, service, bundle byte, or user flow changes.
Known stale unrelated clauses about source availability and Documentation
navigation are preserved for separate review.

Publication note, 2026-10-26: the private artifact path above is shown by its
basename. Historical source hashes, measurements and results are unchanged.
