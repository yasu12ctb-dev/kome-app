import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// 外部への通信は api.github.com だけ（設計書 §8）。開発サーバーはスタイルをページ内に差し込むので、本番のビルドにだけ入れる
const CSP = "default-src 'self'; connect-src 'self' https://api.github.com";
function csp(): Plugin {
  return {
    name: 'kome-csp',
    transformIndexHtml(html, ctx) {
      const tag = ctx.server ? '' : `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
      return html.replace('<!--kome:csp-->', tag);
    },
  };
}

// GitHub Pages（https://<user>.github.io/kome-app/）で配信する
export default defineConfig({
  base: '/kome-app/',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    csp(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // 登録は src/app/autoUpdate.ts で自前に行う（二重登録を避ける）
      injectRegister: null,
      includeAssets: ['icons/apple-touch-icon-180.png'],
      manifest: {
        name: 'お米の記録',
        short_name: 'お米',
        lang: 'ja',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#F3EEE2',
        theme_color: '#F3EEE2',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: { outDir: 'dist' },
});
