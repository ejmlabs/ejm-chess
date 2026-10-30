import type { HeadersOptions } from '@ejm/site/headers';

export const chessHeaders: HeadersOptions = {
  analytics: false,
  extra: {
    'connect-src': ['wss://chess.ejmlabs.com', 'https://challenges.cloudflare.com'],
    'script-src': ['https://challenges.cloudflare.com', "'wasm-unsafe-eval'"],
    'worker-src': ["'self'"],
    'frame-src': ['https://challenges.cloudflare.com'],
  },
};
