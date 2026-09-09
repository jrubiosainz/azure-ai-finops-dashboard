import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  root: here,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${loadEnv(mode, path.resolve(here, '..'), '').PORT || 5173}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
  },
}));
