import { defineConfig } from 'vite';
import { ejmlabs } from '@ejm/site/vite';
import { chessHeaders } from './src/policy.ts';

export default defineConfig({ plugins: [ejmlabs({ project: 'chess', headers: chessHeaders })] });
