/**
 * Hermes Gateway API client.
 * Calls the Hermes API server (port 8642) session endpoints to track active sessions
 * and their message history via polling.
 */

const IS_DEV = import.meta.env.DEV;
const API_BASE = IS_DEV
  ? ''
  : (import.meta.env.VITE_HERMES_API_URL ?? 'http://localhost:8642');
const API_KEY = import.meta.env.VITE_HERMES_API_KEY ?? '';
const POLL_INTERVAL = Number(import.meta.env.VITE_HERMES_POLL_INTERVAL ?? 5000);

// ── Types ────────────────────────────────────────────────────────────────────

export interface HermesSession {
  sessionId: string;
  id: string; // internal — renamed to sessionId in sanitized output
  source: string;
  model?: string;
  title?: string;
  started_at: number;
  ended_at?: number;
  message_count: number;
  preview?: string;
  last_active?: number;
  parent_session_id?: string;
  user_id?: string;
}

export interface HermesMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  tool_name?: string;
  reasoning?: string;
  timestamp?: string;
}

// ── API calls ────────────────────────────────────────────────────────────────

async function apiFetch(path: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function listSessions(limit = 20): Promise<HermesSession[]> {
  const data = await apiFetch(`/api/sessions?limit=${limit}`);
  return (data.sessions ?? []) as HermesSession[];
}

export async function getSessionMessages(
  sessionId: string,
  limit = 50,
  offset = 0,
): Promise<HermesMessage[]> {
  const data = await apiFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=${offset}`,
  );
  return (data.messages ?? []) as HermesMessage[];
}

// ── Polling ──────────────────────────────────────────────────────────────────

export type SessionUpdateHandler = (sessions: HermesSession[]) => void;

export interface HermesPoller {
  start(): void;
  stop(): void;
  poll(): Promise<void>;
  readonly connected: boolean;
}

export function createPoller(
  onUpdate: SessionUpdateHandler,
  onStatusChange?: (connected: boolean) => void,
): HermesPoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let connected = false;

  async function doPoll() {
    try {
      const sessions = await listSessions(50);
      if (!connected) {
        connected = true;
        onStatusChange?.(true);
      }
      onUpdate(sessions);
    } catch (err) {
      console.warn('[Hermes] Poll failed:', err);
      if (connected) {
        connected = false;
        onStatusChange?.(false);
      }
    }
  }

  return {
    start() {
      doPoll();
      timer = setInterval(doPoll, POLL_INTERVAL);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async poll() {
      await doPoll();
    },
    get connected() {
      return connected;
    },
  };
}
