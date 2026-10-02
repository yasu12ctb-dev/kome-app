import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { setupAutoUpdate } from './app/autoUpdate';
import { appReloadCoordinator } from './app/reload';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// 自動アップデート（I11）。開発中（vite dev）は Service Worker を登録しない
if (import.meta.env.PROD) setupAutoUpdate({ win: window, registerSW, coordinator: appReloadCoordinator() });
