import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyDshTheme, readDshTheme } from './dsh-theme';
import { PanelProvider } from './store';
import './index.css';

// 首帧之前先把宿主主题写上，避免嵌在 DSH 里时闪一下浅色。
applyDshTheme(readDshTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PanelProvider>
      <App />
    </PanelProvider>
  </StrictMode>,
);
