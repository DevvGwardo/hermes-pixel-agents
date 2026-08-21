# Hermes Pixel Agents

A pixel art office where your Hermes AI agents come to life as animated characters. Each agent session becomes a character that walks around, sits at their desk, and visually reflects what they're doing.

Forked from [pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents) and adapted from a VS Code extension to a standalone web app for Hermes.

![Hermes Pixel Agents](public/screenshot.png)

## Features

- **One agent, one character** — every Hermes session gets its own animated character
- **Live activity tracking** — characters show what the agent is doing (reading, writing, searching, running commands)
- **Sub-agent visualization** — spawned sub-agents appear as separate characters with their task description
- **Office layout editor** — design your office with floors, walls, and furniture
- **25 furniture items** — desks, PCs (with on/off animation), chairs, sofas, plants, bookshelves, paintings, and more
- **6 diverse character sprites** — based on [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)
- **Persistent layouts** — your office design is saved in localStorage
- **Sound notifications** — optional chime when an agent finishes

## Prerequisites

- Hermes agent running with the API server enabled (`api_server.enabled: true` in config.yaml, default port 8642)

## Quick Start

```bash
git clone https://github.com/DevvGwardo/hermes-pixel-agents.git
cd hermes-pixel-agents
cp .env.example .env    # edit if your API server runs on a different port
npm install
npm run dev
```

Then open http://localhost:5173/ in your browser.

### Configuration

Create a `.env` file (or copy `.env.example`):

```env
# Hermes API server URL (default port is 8642)
VITE_HERMES_API_URL=http://localhost:8642

# API key (optional — leave blank if no auth configured)
VITE_HERMES_API_KEY=

# Polling interval in milliseconds (default: 5000)
VITE_HERMES_POLL_INTERVAL=5000
```

In development, the Vite dev server proxies API requests to the local server (no CORS issues).

## How It Works

1. Polls the Hermes API server (`/api/sessions`) to detect active sessions
2. Monitors session message history for tool calls and activity
3. Maps each session to an animated pixel character in the office
4. Shows tool activity as labels above characters ("Reading file.ts", "Running: npm build", etc.)

## Usage

- **+ Agent** — shows connection status
- **Layout** — open the office editor to customize your space
- **Settings** — configure sound and other options
- Click a character to select it, click a seat to reassign

### Layout Editor

- **Floor** — paint floor tiles with color control
- **Walls** — auto-tiling walls with color customization
- **Furniture** — place desks, chairs, PCs, plants, and decorations
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — share layouts as JSON files

## Architecture

```
src/
  api/
    hermesClient.ts    — HTTP client for Hermes API server
    hermesAdapter.ts  — maps Hermes sessions → pixel-agent messages
  components/          — React UI components
  hooks/               — React hooks for messages and state
  office/              — Canvas rendering engine (pixel art office)
```

The adapter (`hermesAdapter.ts`) handles:
- Session polling and lifecycle detection
- Tool call extraction from message history
- Sub-agent tracking and character management
- Activity categorization (typing, reading, running, searching, spawning)

## Credits

- Original [Pixel Agents](https://github.com/pablodelucca/pixel-agents) by Pablo De Lucca
- Character sprites by [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)
- Crab sprite reference by [Elthen](https://elthen.itch.io/2d-pixel-art-crab-sprites)
- Built for [Hermes](https://github.com/DevvGwardo/hermes-agent)

## License

[MIT](LICENSE)
