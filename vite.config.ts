import { defineConfig } from 'vite';
import { ejmlabs } from '@ejm/site/vite';
import { chessHeaders } from './src/policy.ts';

// The preset carries Tailwind, React, one React, the design guard, prerendering and the build options.
// `headers` is chess only (src/policy.ts): no analytics, plus the Turnstile, game WebSocket and Stockfish WebAssembly
// additions to the shared policy.
export default defineConfig({ plugins: [ejmlabs({ project: 'chess', headers: chessHeaders })] });
