const STORAGE_KEY = 'pixel-agents-screens';

export interface ScreenConfig {
  id: string;
  label: string;
  youtubeVideoId: string;
  enabled: boolean;
}

const DEFAULT_SCREENS: ScreenConfig[] = [
  { id: 'screen-1', label: 'Night of the Living Dead', youtubeVideoId: 'jclhVKSC0Tk', enabled: true },
  { id: 'screen-2', label: 'Nosferatu', youtubeVideoId: 'FC6jFoYm3xs', enabled: true },
  { id: 'screen-3', label: 'Metropolis', youtubeVideoId: 'X-S5v4UwhAE', enabled: true },
  { id: 'screen-4', label: 'His Girl Friday', youtubeVideoId: 'kmYcT5gT6a4', enabled: true },
];

let cachedScreens: ScreenConfig[] | null = null;

export function getScreens(): ScreenConfig[] {
  if (cachedScreens) return cachedScreens;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ScreenConfig[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        cachedScreens = parsed;
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  cachedScreens = DEFAULT_SCREENS;
  return DEFAULT_SCREENS;
}

export function saveScreens(screens: ScreenConfig[]): void {
  cachedScreens = screens;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(screens));
}

export function getEnabledScreens(): ScreenConfig[] {
  return getScreens().filter((s) => s.enabled);
}

let nextId = Date.now();
export function createScreenId(): string {
  return `screen-${++nextId}`;
}
