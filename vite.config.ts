import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { ejmSite } from '@ejm/site/vite';
import { ejmSsg } from '@ejm/ssg/vite';
import { chessHeaders } from './src/policy.ts';

export default defineConfig({
  plugins: [react(), tailwindcss(), ejmSite({ project: 'chess', headers: chessHeaders }), ejmSsg({ site: 'src/site.tsx' })],
  resolve: { dedupe: ['react', 'react-dom'] },
});
