import { defineConfig } from 'vite';

// U2 の関門の確認ページ（spike/gate）。本番と同じく、ビルドした静的ファイルを配信して確かめる
export default defineConfig({
  root: 'spike/gate',
  build: { outDir: 'dist', emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
});
