import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // GitHub Pages デプロイ用の相対パス設定
  server: {
    port: 3000,
    open: true
  },
  build: {
    // OpenCV.js の WASM ファイルを正しく扱うための設定
    assetsInlineLimit: 0,
  }
});
