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

// ── File reading (for transcript tailing) ───────────────────────────────

async function readFileChunk(
  filePath: string,
  offset: number,
): Promise<{ text: string; error?: string }> {
  try {
    const resp = await toolInvoke('read', { path: filePath, offset });
    if (!resp.ok) return { text: '', error: resp.error?.message ?? 'read failed' };
    const textBlock = resp.result?.content?.find((c) => c.type === 'text');
    return { text: textBlock?.text ?? '' };
  } catch (err) {
    return { text: '', error: String(err) };
  }
}

// ── Transcript watcher ──────────────────────────────────────────────────

export interface TranscriptToolUse {
  kind: 'tool_use';
  name: string;
  toolUseId?: string;
  input: Record<string, unknown>;
}

export interface TranscriptToolResult {
  kind: 'tool_result';
  name?: string;
  toolUseId?: string;
  content: unknown;
}

export interface TranscriptText {
  kind: 'text';
  text: string;
}

export type TranscriptEvent = TranscriptToolUse | TranscriptToolResult | TranscriptText;
export type TranscriptEventHandler = (events: TranscriptEvent[]) => void;

const TRANSCRIPT_POLL_INTERVAL = 1500;

export interface TranscriptWatcher {
  start(transcriptPath: string): void;
  stop(): void;
  readonly watching: boolean;
}

export function createTranscriptWatcher(
  onEvents: TranscriptEventHandler,
): TranscriptWatcher {
  let timer: ReturnType<typeof setInterval> | null = null;
  let linesRead = 0;
  let currentPath: string | null = null;
  let polling = false;

  async function doPoll() {
    if (!currentPath || polling) return;
    polling = true;
    try {
      const { text, error } = await readFileChunk(currentPath, linesRead);
      if (error || !text) {
        polling = false;
        return;
      }

      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length === 0) {
        polling = false;
        return;
      }
      linesRead += lines.length;

      const events: TranscriptEvent[] = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const role = obj.role as string | undefined;
          const content = obj.content;

          if (!Array.isArray(content)) continue;

          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (role === 'assistant' && b.type === 'tool_use') {
              events.push({
                kind: 'tool_use',
                name: b.name as string,
                toolUseId: b.id as string | undefined,
                input: (b.input as Record<string, unknown>) ?? {},
              });
            } else if (role === 'tool' && b.type === 'tool_result') {
              events.push({
                kind: 'tool_result',
                name: b.name as string | undefined,
                toolUseId: b.tool_use_id as string | undefined,
                content: b.content,
              });
            } else if (role === 'assistant' && b.type === 'text') {
              events.push({
                kind: 'text',
                text: b.text as string,
              });
            }
          }
        } catch {
          // skip malformed lines
        }
      }

      if (events.length > 0) {
        onEvents(events);
      }
    } catch (err) {
      console.warn('[TranscriptWatcher] Poll error:', err);
    }
    polling = false;
  }

  return {
    start(transcriptPath: string) {
      if (timer && currentPath === transcriptPath) return;
      this.stop();
      currentPath = transcriptPath;
      linesRead = 0;
      doPoll();
      timer = setInterval(doPoll, TRANSCRIPT_POLL_INTERVAL);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      currentPath = null;
      linesRead = 0;
      polling = false;
    },
    get watching() {
      return currentPath !== null;
    },
  };
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
