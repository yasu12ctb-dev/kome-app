import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { setupAutoUpdate } from './app/autoUpdate';
import { App } from './ui/App';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 自動アップデート（I11）。開発中（vite dev）は Service Worker を登録しない
if (import.meta.env.PROD) setupAutoUpdate({ win: window, registerSW });
