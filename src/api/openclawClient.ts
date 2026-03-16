/**
 * OpenClaw Gateway API client.
 * Uses the /tools/invoke HTTP endpoint to query sessions and history.
 * Polls for changes instead of WebSocket (gateway WS requires complex handshake).
 */

// In dev mode, use relative URL so requests go through Vite's proxy (avoids CORS).
// The proxy injects the auth token, so the browser never needs it.
// In production, use the configured gateway URL and token directly.
const IS_DEV = import.meta.env.DEV;
const GATEWAY_URL = IS_DEV ? '' : (import.meta.env.VITE_OPENCLAW_GATEWAY_URL ?? 'http://localhost:18789');
const GATEWAY_TOKEN = IS_DEV ? '' : (import.meta.env.VITE_OPENCLAW_GATEWAY_TOKEN ?? '');
const POLL_INTERVAL = Number(import.meta.env.VITE_OPENCLAW_POLL_INTERVAL ?? 5000);

// ── Generic tool invoke ─────────────────────────────────────────────────

interface ToolInvokeResponse {
  ok: boolean;
  result?: {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  error?: { message: string; type: string };
}

async function toolInvoke(
  tool: string,
  args: Record<string, unknown> = {},
  sessionKey?: string,
): Promise<ToolInvokeResponse> {
  const body: Record<string, unknown> = { tool, args };
  if (sessionKey) body.sessionKey = sessionKey;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${GATEWAY_TOKEN}`;

  const res = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`tools/invoke ${tool} failed (${res.status}): ${text}`);
  }

  return (await res.json()) as ToolInvokeResponse;
}

// ── Session types ───────────────────────────────────────────────────────

export interface OpenClawSession {
  key: string;
  kind: string;
  channel?: string;
  displayName?: string;
  updatedAt?: number;
  sessionId?: string;
  model?: string;
  totalTokens?: number;
  lastChannel?: string;
  transcriptPath?: string;
  parentKey?: string;
}

export interface OpenClawHistoryMessage {
  role: string;
  content: unknown;
  timestamp?: string;
}

// ── API wrappers ────────────────────────────────────────────────────────

export async function listSessions(
  limit = 20,
  activeMinutes?: number,
): Promise<OpenClawSession[]> {
  const args: Record<string, unknown> = { limit, messageLimit: 0 };
  if (activeMinutes !== undefined && activeMinutes > 0) args.activeMinutes = activeMinutes;

  const resp = await toolInvoke('sessions_list', args);
  if (!resp.ok || !resp.result?.details) return [];

  const details = resp.result.details as { sessions?: OpenClawSession[] };
  return details.sessions ?? [];
}

export async function getSessionHistory(
  sessionKey: string,
  limit = 30,
  includeTools = true,
): Promise<OpenClawHistoryMessage[]> {
  const resp = await toolInvoke('sessions_history', {
    sessionKey,
    limit,
    includeTools,
  });
  if (!resp.ok || !resp.result?.details) return [];

  const details = resp.result.details;
  // sessions_history returns messages array
  if (Array.isArray(details)) return details as OpenClawHistoryMessage[];
  if (Array.isArray((details as Record<string, unknown>).messages)) {
    return (details as Record<string, unknown>).messages as OpenClawHistoryMessage[];
  }
  return [];
}

// ── Polling-based connection ────────────────────────────────────────────

export type SessionUpdateHandler = (sessions: OpenClawSession[]) => void;

export interface OpenClawPoller {
  start(): void;
  stop(): void;
  poll(): Promise<void>;
  readonly connected: boolean;
}

export function createPoller(
  onUpdate: SessionUpdateHandler,
  onStatusChange?: (connected: boolean) => void,
): OpenClawPoller {
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
      console.warn('[OpenClaw] Poll failed:', err);
      if (connected) {
        connected = false;
        onStatusChange?.(false);
      }
    }
  }

  return {
    start() {
      doPoll(); // immediate first poll
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
