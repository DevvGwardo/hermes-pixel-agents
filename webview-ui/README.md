# OpenClaw Pixel Agents

Pixel art office visualization for [OpenClaw](https://github.com/openclaw) AI agent sessions. Watch your agents come to life as animated characters in a customizable pixel art office.

## Quick Start

```sh
cd webview-ui
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

## Configuration

Copy `.env.example` to `.env` and configure:

```
VITE_OPENCLAW_GATEWAY_URL=http://localhost:3117
VITE_OPENCLAW_GATEWAY_TOKEN=
```

## Build

```sh
npm run build
npm run preview
```

Output goes to `dist/` — deploy anywhere as a static site.

## How It Works

The app connects to the OpenClaw Gateway API via WebSocket for real-time agent session events. Each active session becomes an animated pixel art character in the office.

- **Sessions** map to agent characters with unique appearances
- **Tool calls** (read, write, exec, etc.) trigger typing/reading animations
- **Sub-agent sessions** spawn sub-agent characters near the parent
- **Idle/waiting** agents wander the office or sit at their desks

## Features

- Full office layout editor (floors, walls, furniture)
- 6 unique character palettes with hue shift variations
- Spawn/despawn matrix-style animations
- Sound notifications when agents complete turns
- Export/import office layouts as JSON
- Zoom controls and camera follow

## Architecture

```
src/
  api/
    openclawClient.ts    -- HTTP + WebSocket client for OpenClaw Gateway
    openclawAdapter.ts   -- Maps OpenClaw events to pixel-agents messages
    assetLoader.ts       -- Loads sprites from /assets/ via browser APIs
  messageBus.ts          -- Event bus replacing VS Code postMessage
  App.tsx                -- Main React component
  hooks/                 -- React hooks (messages, editor, keyboard)
  components/            -- UI components (toolbar, settings, debug)
  office/                -- Game engine (unchanged from pixel-agents)
    engine/              -- Game loop, renderer, characters, state
    layout/              -- Furniture catalog, serializer, pathfinding
    editor/              -- Layout editor tools and state
    sprites/             -- Sprite data and caching
    components/          -- Canvas and overlay components
public/assets/           -- Pixel art assets (characters, furniture, tiles)
```

## Based On

This is a standalone web port of [Pixel Agents](https://github.com/pablodelucca/pixel-agents), a VS Code extension by Pablo De Lucca. All pixel art rendering, animations, and office editor code is preserved.
