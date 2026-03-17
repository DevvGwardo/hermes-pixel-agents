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

async function loadFloorTiles(): Promise<void> {
  const FLOOR_COUNT = 9;
  const sprites: string[][][] = [];
  for (let i = 0; i < FLOOR_COUNT; i++) {
    try {
      const img = await loadImage(`./assets/floors/floor_${i}.png`);
      sprites.push(pngToSpriteData(img));
    } catch (e) {
      console.warn(`[AssetLoader] Failed to load floor_${i}.png:`, e);
    }
  }
  if (sprites.length > 0) {
    dispatchToWebview({ type: 'floorTilesLoaded', sprites });
  }
}

// ── Wall tiles ──────────────────────────────────────────────────────────

const WALL_TILE_W = 16;
const WALL_TILE_H = 32;
const WALL_GRID_COLS = 4;
const WALL_GRID_ROWS = 4;

async function loadWallTiles(): Promise<void> {
  try {
    const img = await loadImage('./assets/walls/wall_0.png');
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

const FURNITURE_FOLDERS = [
  'BIN', 'BOOKSHELF', 'CACTUS', 'CLOCK', 'COFFEE', 'COFFEE_TABLE',
  'CUSHIONED_BENCH', 'CUSHIONED_CHAIR', 'DESK', 'DOUBLE_BOOKSHELF',
  'HANGING_PLANT', 'LARGE_PAINTING', 'LARGE_PLANT', 'PC', 'PLANT',
  'PLANT_2', 'POT', 'SMALL_PAINTING', 'SMALL_PAINTING_2', 'SMALL_TABLE',
  'SOFA', 'TABLE_FRONT', 'WHITEBOARD', 'WOODEN_BENCH', 'WOODEN_CHAIR',
];

interface ManifestNode {
  type: string;
  id?: string;
  name?: string;
  category?: string;
  groupType?: string;
  rotationScheme?: string;
  canPlaceOnWalls?: boolean;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  file?: string;
  width?: number;
  height?: number;
  footprintW?: number;
  footprintH?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  frame?: number;
  members?: ManifestNode[];
}

interface GroupContext {
  groupId: string;
  category: string;
  name: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  rotationScheme?: string;
}

function extractAssets(
  node: ManifestNode,
  folderName: string,
  ctx: GroupContext | null,
): { entry: FurnitureCatalogEntry; file: string; folder: string }[] {
  if (node.type === 'asset') {
    const category = ctx?.category ?? node.category ?? 'misc';
    const file = node.file ?? `${node.id}.png`;
    const entry: FurnitureCatalogEntry = {
      id: node.id ?? folderName,
      name: ctx?.name ?? node.name ?? node.id ?? folderName,
      label: ctx?.name ?? node.name ?? node.id ?? folderName,
      category,
      file,
      width: node.width ?? 16,
      height: node.height ?? 16,
      footprintW: node.footprintW ?? 1,
      footprintH: node.footprintH ?? 1,
      isDesk: category === 'desks',
      canPlaceOnWalls: ctx?.canPlaceOnWalls ?? node.canPlaceOnWalls ?? false,
      canPlaceOnSurfaces: ctx?.canPlaceOnSurfaces ?? node.canPlaceOnSurfaces ?? false,
      backgroundTiles: ctx?.backgroundTiles ?? node.backgroundTiles ?? 0,
      ...(ctx?.groupId && { groupId: ctx.groupId }),
      ...(node.orientation && { orientation: node.orientation }),
      ...(node.state && { state: node.state }),
      ...(node.mirrorSide && { mirrorSide: node.mirrorSide }),
      ...(ctx?.rotationScheme && { rotationScheme: ctx.rotationScheme }),
      ...(node.frame != null && { frame: node.frame }),
    };
    return [{ entry, file, folder: folderName }];
  }

  if (node.type === 'group' && node.members) {
    const groupCtx: GroupContext = {
      groupId: ctx?.groupId ?? node.id ?? folderName,
      category: ctx?.category ?? node.category ?? 'misc',
      name: ctx?.name ?? node.name ?? folderName,
      canPlaceOnWalls: ctx?.canPlaceOnWalls ?? node.canPlaceOnWalls ?? false,
      canPlaceOnSurfaces: ctx?.canPlaceOnSurfaces ?? node.canPlaceOnSurfaces ?? false,
      backgroundTiles: ctx?.backgroundTiles ?? node.backgroundTiles ?? 0,
      rotationScheme: ctx?.rotationScheme ?? node.rotationScheme,
    };

    // For animation groups, propagate the animation group id
    const childCtx: GroupContext = { ...groupCtx };
    if (node.groupType === 'animation') {
      // Children inherit the animation group context
    }

    const results: { entry: FurnitureCatalogEntry; file: string; folder: string }[] = [];
    for (const member of node.members) {
      // Propagate state from parent state group to children
      const memberWithState: ManifestNode =
        node.groupType === 'state' && !member.state ? member : member;
      results.push(...extractAssets(memberWithState, folderName, childCtx));
    }

    // Tag animation group entries
    if (node.groupType === 'animation' && node.state) {
      for (const r of results) {
        if (!r.entry.state) r.entry.state = node.state;
        r.entry.animationGroup = `${groupCtx.groupId}_${node.state}`;
      }
    }

    return results;
  }

  return [];
}

async function loadFurniture(): Promise<void> {
  try {
    const catalog: FurnitureCatalogEntry[] = [];
    const sprites: Record<string, string[][]> = {};

    // Load all manifests in parallel
    const manifestResults = await Promise.all(
      FURNITURE_FOLDERS.map(async (folder) => {
        try {
          const res = await fetch(`./assets/furniture/${folder}/manifest.json`);
          if (!res.ok) return null;
          const manifest = (await res.json()) as ManifestNode;
          return { folder, manifest };
        } catch {
          console.warn(`[AssetLoader] Failed to load manifest for ${folder}`);
          return null;
        }
      }),
    );

    // Extract all catalog entries
    const allAssets: { entry: FurnitureCatalogEntry; file: string; folder: string }[] = [];
    for (const result of manifestResults) {
      if (!result) continue;
      const { folder, manifest } = result;

      if (manifest.type === 'asset') {
        // Simple item — treat the manifest itself as the entry
        const file = manifest.file ?? `${manifest.id ?? folder}.png`;
        const category = manifest.category ?? 'misc';
        catalog.push({
          id: manifest.id ?? folder,
          name: manifest.name ?? folder,
          label: manifest.name ?? folder,
          category,
          file,
          width: manifest.width ?? 16,
          height: manifest.height ?? 16,
          footprintW: manifest.footprintW ?? 1,
          footprintH: manifest.footprintH ?? 1,
          isDesk: category === 'desks',
          canPlaceOnWalls: manifest.canPlaceOnWalls ?? false,
          canPlaceOnSurfaces: manifest.canPlaceOnSurfaces ?? false,
          backgroundTiles: manifest.backgroundTiles ?? 0,
        });
        allAssets.push({ entry: catalog[catalog.length - 1], file, folder });
      } else {
        const extracted = extractAssets(manifest, folder, null);
        for (const a of extracted) {
          catalog.push(a.entry);
          allAssets.push(a);
        }
      }
    }

    // Load all sprites in parallel
    await Promise.all(
      allAssets.map(async ({ entry, file, folder }) => {
        try {
          const img = await loadImage(`./assets/furniture/${folder}/${file}`);
          sprites[entry.id] = pngToSpriteData(img);
        } catch (e) {
          console.warn(`[AssetLoader] Failed to load furniture ${folder}/${file}:`, e);
        }
      }),
    );

    dispatchToWebview({ type: 'furnitureAssetsLoaded', catalog, sprites });
  } catch (e) {
    console.warn('[AssetLoader] Failed to load furniture:', e);
  }
}

// ── Default layout ──────────────────────────────────────────────────────

async function loadDefaultLayout(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch('./assets/default-layout-1.json');
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
let _assetsReady = false;
let _assetsReadyResolve: (() => void) | null = null;
const _assetsReadyPromise = new Promise<void>((resolve) => {
  _assetsReadyResolve = resolve;
});

/** Returns a promise that resolves when all assets have been loaded */
export function waitForAssets(): Promise<void> {
  return _assetsReadyPromise;
}

/** Check if assets are loaded (synchronous) */
export function assetsReady(): boolean {
  return _assetsReady;
}

export async function loadAllAssets(): Promise<void> {
  // Load in correct order (characters first, layout last)
  await loadCharacterSprites();
  await loadFloorTiles();
  await loadWallTiles();
  await loadFurniture();

  // Prepare default layout if none is saved
  const savedLayout = localStorage.getItem('openclaw-pixel-agents-layout');
  if (!savedLayout) {
    const defaultLayout = await loadDefaultLayout();
    if (defaultLayout) {
      localStorage.setItem('openclaw-pixel-agents-layout', JSON.stringify(defaultLayout));
    }
  }

  // Signal that assets are ready
  _assetsReady = true;
  _assetsReadyResolve?.();
}
