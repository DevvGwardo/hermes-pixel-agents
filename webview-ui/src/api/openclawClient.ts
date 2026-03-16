/**
 * OpenClaw Gateway API client.
 * Connects via HTTP + WebSocket to the OpenClaw gateway for real-time agent events.
 */

const GATEWAY_URL = import.meta.env.VITE_OPENCLAW_GATEWAY_URL ?? 'http://localhost:3117';
const GATEWAY_TOKEN = import.meta.env.VITE_OPENCLAW_GATEWAY_TOKEN ?? '';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GATEWAY_TOKEN) h['Authorization'] = `Bearer ${GATEWAY_TOKEN}`;
  return h;
}

// ── HTTP endpoints ──────────────────────────────────────────────────────

export interface OpenClawSession {
  key: string;
  kind: string;
  status: string;
  parentKey?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenClawHistoryEntry {
  type: string;
  data: Record<string, unknown>;
  timestamp?: string;
}

export async function fetchSessions(): Promise<OpenClawSession[]> {
  const res = await fetch(`${GATEWAY_URL}/api/sessions`, { headers: headers() });
  if (!res.ok) throw new Error(`GET /api/sessions failed: ${res.status}`);
  return (await res.json()) as OpenClawSession[];
}

export async function fetchSessionHistory(key: string): Promise<OpenClawHistoryEntry[]> {
  const res = await fetch(`${GATEWAY_URL}/api/sessions/${encodeURIComponent(key)}/history`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GET /api/sessions/${key}/history failed: ${res.status}`);
  return (await res.json()) as OpenClawHistoryEntry[];
}

// ── WebSocket ───────────────────────────────────────────────────────────

export type WsEventHandler = (event: Record<string, unknown>) => void;

export interface OpenClawConnection {
  /** Close the WebSocket */
  close(): void;
  /** Whether the WebSocket is currently connected */
  readonly connected: boolean;
}

/**
 * Connect to the gateway WebSocket for real-time session events.
 * Auto-reconnects with exponential backoff.
 */
export function connectWebSocket(
  onEvent: WsEventHandler,
  onStatusChange?: (connected: boolean) => void,
): OpenClawConnection {
  let ws: WebSocket | null = null;
  let alive = true;
  let backoff = 1000;
  let connected = false;

  function connect() {
    if (!alive) return;

    const wsUrl = GATEWAY_URL.replace(/^http/, 'ws') + '/ws';
    const url = GATEWAY_TOKEN ? `${wsUrl}?token=${encodeURIComponent(GATEWAY_TOKEN)}` : wsUrl;
    ws = new WebSocket(url);

    ws.onopen = () => {
      backoff = 1000;
      connected = true;
      onStatusChange?.(true);
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data as string) as Record<string, unknown>;
        onEvent(data);
      } catch {
        console.warn('[OpenClaw WS] Failed to parse message:', e.data);
      }
    };

    ws.onclose = () => {
      connected = false;
      onStatusChange?.(false);
      if (alive) {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return {
    close() {
      alive = false;
      ws?.close();
    },
    get connected() {
      return connected;
    },
  };
}
