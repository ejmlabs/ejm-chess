# Stockfish browser engine

This directory distributes the unchanged Stockfish.js 19.0.1 lite single-thread
engine maintained by Nathan Rugg and contributors. The engine derives from
Stockfish. It runs as a classic browser worker with one thread and an embedded
lite neural network. Read [COPYING.txt](COPYING.txt) for GPLv3 terms and
[AUTHORS](AUTHORS) for upstream credits. The engine carries no warranty.

## Corresponding source

- [Exact source archive](source.tar.gz), upstream commit
  `0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`, release `v19.0.1`.
- [Matching neural network](nn-61e7af4bb97d.nnue), required to rebuild the lite
  engine. The distributed WASM already embeds it, so browser play does not
  download this separate file.
- [Provenance, acquisition URLs, sizes, and SHA-256 hashes](PROVENANCE.json).

Serve these files alongside both runtime files. Do not replace the source link
with a link to an unpinned branch or remove it from the deployed assets.

To build from this source, use Emscripten 6.0.9, Node.js 24, GNU Make, and a C++
build toolchain. The upstream source includes its build scripts and package
manifest. From this directory:

```sh
tar -xzf source.tar.gz
cp nn-61e7af4bb97d.nnue stockfish.js-0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6/src/
cd stockfish.js-0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6
npm install --ignore-scripts
node build.js --lite --single-threaded --no-split --strict-em-check
```

The build writes `src/stockfish-19-lite-single.js` and the matching `.wasm`.
The source declares the Terser build dependency. Consult its README for the
full toolchain. The published package reports Node.js 24.18.0. We distribute
upstream release binaries and verify their published release hashes; we have
not claimed a bit-for-bit rebuild of those binaries.

## Runtime bounds

Only the JavaScript and WASM are loaded for computer play: 1,874,201 raw bytes
in total. Neither is needed for ordinary human play or guides. No external
model service, API key, or token is used. All deployed files come from the
same Cloudflare host.

The product sets Threads=1, Hash=16 MiB, Ponder=false, and MultiPV=1. Named
difficulties use Skill Level 0, 6, 12, or 20 and searches of 150, 300, 600, or
1,200 ms. These are engine settings, not tested Elo ratings. Strength and actual
elapsed time depend on the device.

The upstream binary starts with 128 MiB of WASM linear memory and allows
growth up to 2 GiB. Hash=16 is a transposition-table setting, not a total memory
limit. The page runs at most one practice worker and terminates it on failure,
cancellation, or disposal. A search timeout terminates the worker without a
substitute move. Computer play uses server clocks, which continue while the
tab is suspended or disconnected.

From the product checkout, `npm run engine:check` verifies all distributed
inputs without using the network. `npm run engine:fetch` restores the pinned
upstream inputs with bounded downloads and verifies every size and hash.
Neither command installs the 205 MB multi-variant npm package.

`npm run engine:probe` exercises UCI readiness and legal output from all four
settings through the unchanged engine's supported Node interface. It records
local startup/search timing and Node memory, which do not establish browser
latency, memory, chess strength, or Elo.
