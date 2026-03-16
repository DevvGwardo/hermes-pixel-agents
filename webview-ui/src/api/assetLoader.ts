/**
 * Standalone asset loader.
 * Loads character sprites, floor tiles, wall tiles, furniture catalog + sprites
 * from static files in /assets/ and dispatches them to the webview message bus.
 */

import { dispatchToWebview } from '../messageBus.js';

// ── PNG → SpriteData helpers ────────────────────────────────────────────

/** Parse a PNG image into a 2D hex color array (SpriteData format) */
function pngToSpriteData(img: HTMLImageElement): string[][] {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const data = imageData.data;
  const rows: string[][] = [];
  for (let y = 0; y < img.height; y++) {
    const row: string[] = [];
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 2) {
        row.push('');
      } else if (a < 255) {
        // Semi-transparent — use #RRGGBBAA format
        row.push(
          '#' +
            r.toString(16).padStart(2, '0') +
            g.toString(16).padStart(2, '0') +
            b.toString(16).padStart(2, '0') +
            a.toString(16).padStart(2, '0'),
        );
      } else {
        row.push(
          '#' +
            r.toString(16).padStart(2, '0') +
            g.toString(16).padStart(2, '0') +
            b.toString(16).padStart(2, '0'),
        );
      }
    }
    rows.push(row);
  }
  return rows;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

// ── Character sprites ───────────────────────────────────────────────────

const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES = 7;
const CHAR_DIRECTIONS = 3; // down, up, right

interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

function parseCharacterSheet(spriteData: string[][]): CharacterSpriteSet {
  const result: CharacterSpriteSet = { down: [], up: [], right: [] };
  const directions: (keyof CharacterSpriteSet)[] = ['down', 'up', 'right'];

  for (let dir = 0; dir < CHAR_DIRECTIONS; dir++) {
    const startY = dir * CHAR_FRAME_H;
    for (let frame = 0; frame < CHAR_FRAMES; frame++) {
      const startX = frame * CHAR_FRAME_W;
      const frameData: string[][] = [];
      for (let y = 0; y < CHAR_FRAME_H; y++) {
        const row: string[] = [];
        for (let x = 0; x < CHAR_FRAME_W; x++) {
          row.push(spriteData[startY + y]?.[startX + x] ?? '');
        }
        frameData.push(row);
      }
      result[directions[dir]].push(frameData);
    }
  }
  return result;
}

async function loadCharacterSprites(): Promise<void> {
  const characters: CharacterSpriteSet[] = [];
  for (let i = 0; i < 6; i++) {
    try {
      const img = await loadImage(`./assets/characters/char_${i}.png`);
      const spriteData = pngToSpriteData(img);
      characters.push(parseCharacterSheet(spriteData));
    } catch (e) {
      console.warn(`[AssetLoader] Failed to load char_${i}.png:`, e);
    }
  }
  if (characters.length > 0) {
    dispatchToWebview({ type: 'characterSpritesLoaded', characters });
  }
}

// ── Floor tiles ─────────────────────────────────────────────────────────

const FLOOR_TILE_SIZE = 16;

async function loadFloorTiles(): Promise<void> {
  try {
    const img = await loadImage('./assets/floors.png');
    const spriteData = pngToSpriteData(img);
    const sprites: string[][][] = [];
    const count = Math.floor(img.width / FLOOR_TILE_SIZE);
    for (let i = 0; i < count; i++) {
      const tile: string[][] = [];
      for (let y = 0; y < FLOOR_TILE_SIZE; y++) {
        const row: string[] = [];
        for (let x = 0; x < FLOOR_TILE_SIZE; x++) {
          row.push(spriteData[y]?.[i * FLOOR_TILE_SIZE + x] ?? '');
        }
        tile.push(row);
      }
      sprites.push(tile);
    }
    dispatchToWebview({ type: 'floorTilesLoaded', sprites });
  } catch (e) {
    console.warn('[AssetLoader] Failed to load floors.png:', e);
  }
}

// ── Wall tiles ──────────────────────────────────────────────────────────

const WALL_TILE_W = 16;
const WALL_TILE_H = 32;
const WALL_GRID_COLS = 4;
const WALL_GRID_ROWS = 4;

async function loadWallTiles(): Promise<void> {
  try {
    const img = await loadImage('./assets/walls.png');
    const spriteData = pngToSpriteData(img);
    // Single wall set: 4x4 grid of 16x32 tiles
    const tiles: string[][][] = [];
    for (let gy = 0; gy < WALL_GRID_ROWS; gy++) {
      for (let gx = 0; gx < WALL_GRID_COLS; gx++) {
        const tile: string[][] = [];
        for (let y = 0; y < WALL_TILE_H; y++) {
          const row: string[] = [];
          for (let x = 0; x < WALL_TILE_W; x++) {
            row.push(spriteData[gy * WALL_TILE_H + y]?.[gx * WALL_TILE_W + x] ?? '');
          }
          tile.push(row);
        }
        tiles.push(tile);
      }
    }
    dispatchToWebview({ type: 'wallTilesLoaded', sets: [tiles] });
  } catch (e) {
    console.warn('[AssetLoader] Failed to load walls.png:', e);
  }
}

// ── Furniture ───────────────────────────────────────────────────────────

interface FurnitureCatalogEntry {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

async function loadFurniture(): Promise<void> {
  try {
    const res = await fetch('./assets/furniture-catalog.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = (await res.json()) as FurnitureCatalogEntry[];

    // Load all furniture sprites in parallel
    const sprites: Record<string, string[][]> = {};
    const loadPromises = catalog.map(async (entry) => {
      try {
        const img = await loadImage(`./assets/furniture/${entry.file}`);
        sprites[entry.id] = pngToSpriteData(img);
      } catch (e) {
        console.warn(`[AssetLoader] Failed to load furniture ${entry.file}:`, e);
      }
    });
    await Promise.all(loadPromises);

    dispatchToWebview({ type: 'furnitureAssetsLoaded', catalog, sprites });
  } catch (e) {
    console.warn('[AssetLoader] Failed to load furniture catalog:', e);
  }
}

// ── Default layout ──────────────────────────────────────────────────────

async function loadDefaultLayout(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch('./assets/default-layout.json');
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Public entry point ──────────────────────────────────────────────────

/**
 * Load all assets and dispatch them to the webview.
 * Called once at startup. Assets are loaded in the correct order:
 * characters → floors → walls → furniture → layout
 */
export async function loadAllAssets(): Promise<void> {
  // Load in correct order (characters first, layout last)
  await loadCharacterSprites();
  await loadFloorTiles();
  await loadWallTiles();
  await loadFurniture();

  // Layout is dispatched by the adapter after assets are ready,
  // but we prepare the default layout here if none is saved.
  const savedLayout = localStorage.getItem('openclaw-pixel-agents-layout');
  if (!savedLayout) {
    const defaultLayout = await loadDefaultLayout();
    if (defaultLayout) {
      localStorage.setItem('openclaw-pixel-agents-layout', JSON.stringify(defaultLayout));
    }
  }
}
