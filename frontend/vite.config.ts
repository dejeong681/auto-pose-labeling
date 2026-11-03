import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const backend = process.env.VITE_API_URL || env.VITE_API_URL || 'http://127.0.0.1:8000';
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // 브라우저는 같은 주소로 요청하고 Vite가 FastAPI에 전달합니다.
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/images': { target: backend, changeOrigin: true },
      },
    },
  };
});
