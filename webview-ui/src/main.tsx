import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { loadAllAssets } from './api/assetLoader.js';
import { startAdapter } from './api/openclawAdapter.js';
import App from './App.js';

// Start the OpenClaw adapter (handles outbound messages + WebSocket)
startAdapter();

// Load all pixel art assets (characters, floors, walls, furniture)
void loadAllAssets();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
