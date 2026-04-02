import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { loadAllAssets } from './api/assetLoader.js';
import { startAdapter } from './api/hermesAdapter.js';
import App from './App.js';

// Start adapter first so it catches the webviewReady message from React
startAdapter();

// Load assets in parallel — they dispatch their own messages when ready.
// The adapter will wait for assets before sending the layout.
void loadAllAssets();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
