import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiUrl = env.VITE_HERMES_API_URL || 'http://127.0.0.1:8642';
  const apiKey = env.VITE_HERMES_API_KEY || '';

  return {
    plugins: [react()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    base: './',
    server: {
      proxy: {
        '/api': {
          target: apiUrl,
          changeOrigin: true,
          headers: apiKey
            ? { Authorization: `Bearer ${apiKey}` }
            : undefined,
        },
      },
    },
  };
});
