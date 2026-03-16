/**
 * OpenClaw Adapter — maps OpenClaw Gateway sessions to the pixel-agents message format.
 * Uses polling via /tools/invoke to track sessions and their activity.
 */

import {
  createPoller,
  createTranscriptWatcher,
  listSessions,
  type OpenClawPoller,
  type OpenClawSession,
  type TranscriptEvent,
  type TranscriptWatcher,
} from './openclawClient.js';
import { dispatchToWebview, onOutboundMessage } from '../messageBus.js';

// ── Tool name mapping ───────────────────────────────────────────────────

const TOOL_NAME_MAP: Record<string, string> = {
  exec: 'Bash',
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  task: 'Task',
  agent: 'Task',
  notebook_edit: 'NotebookEdit',
  mcp: 'MCP',
  sessions_spawn: 'Task',
  sessions_send: 'Task',
  image: 'WebFetch',
  memory_search: 'Grep',
  memory_get: 'Read',
  web_search_brave: 'WebSearch',
  cron: 'Bash',
  session_status: 'Read',
};

/** Map an OpenClaw tool name to the pixel-agents display name */
export function mapToolName(openclawTool: string): string {
  const lower = openclawTool.toLowerCase();
  return TOOL_NAME_MAP[lower] ?? openclawTool;
}

// ── Session → Agent ID mapping ──────────────────────────────────────────

let nextAgentId = 1;
const sessionToAgent = new Map<string, number>();
const agentToSession = new Map<number, string>();
const knownSessions = new Map<string, OpenClawSession>();

function getOrCreateAgentId(sessionKey: string): number {
  let id = sessionToAgent.get(sessionKey);
  if (id === undefined) {
    id = nextAgentId++;
    sessionToAgent.set(sessionKey, id);
    agentToSession.set(id, sessionKey);
  }
  return id;
}

// ── Subagent tracking ────────────────────────────────────────────────────

/** Maps subagent unique key (tool_use id) → agent ID */
const subagentIds = new Map<string, number>();
/** Maps tool_use id → display label for subagents */
const subagentLabels = new Map<string, string>();
/** Tracks pending Agent tool_use IDs that haven't completed yet */
const pendingAgentToolUseIds = new Set<string>();
/** Tracks the last tool activity time per agent ID */
const agentLastActivity = new Map<number, number>();
/** The main (first) session's agent ID, set once sessions come in */
let mainAgentId: number | null = null;

const IDLE_TIMEOUT_MS = 10_000;

// ── Tool → animation category mapping ────────────────────────────────────

type ActivityCategory = 'typing' | 'reading' | 'running' | 'searching' | 'spawning';

const TOOL_ACTIVITY: Record<string, ActivityCategory> = {
  write: 'typing',
  edit: 'typing',
  read: 'reading',
  glob: 'reading',
  grep: 'reading',
  memory_search: 'reading',
  memory_get: 'reading',
  exec: 'running',
  bash: 'running',
  cron: 'running',
  web_search: 'searching',
  web_fetch: 'searching',
  web_search_brave: 'searching',
  sessions_spawn: 'spawning',
  agent: 'spawning',
  task: 'spawning',
};

function getActivityForTool(toolName: string): ActivityCategory {
  return TOOL_ACTIVITY[toolName.toLowerCase()] ?? 'running';
}

// ── Transcript event handler ─────────────────────────────────────────────

/** Tool names that indicate subagent spawning (case-insensitive match) */
const SUBAGENT_TOOL_NAMES = new Set(['agent', 'task', 'sessions_spawn']);

function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name.toLowerCase());
}

function handleTranscriptEvents(events: TranscriptEvent[]): void {
  for (const event of events) {
    if (event.kind === 'tool_use') {
      // Detect subagent spawning
      if (isSubagentTool(event.name)) {
        const toolUseId = event.toolUseId ?? `anon-${Date.now()}-${Math.random()}`;
        // Use description (Agent tool) or label/task (legacy) for display
        const label =
          (event.input.description as string) ??
          (event.input.label as string) ??
          (event.input.task as string)?.slice(0, 40) ??
          'subagent';

        if (!subagentIds.has(toolUseId)) {
          const id = getOrCreateAgentId(`subagent:${toolUseId}`);
          subagentIds.set(toolUseId, id);
          subagentLabels.set(toolUseId, label);
          pendingAgentToolUseIds.add(toolUseId);
          dispatchToWebview({ type: 'agentCreated', id, folderName: label });
          dispatchToWebview({ type: 'agentStatus', id, status: 'active' });
          agentLastActivity.set(id, Date.now());
          console.log(`[Adapter] Subagent spawned: "${label}" (${toolUseId}) → agent ${id}`);
        } else {
          // Already known subagent, mark active again
          const id = subagentIds.get(toolUseId)!;
          dispatchToWebview({ type: 'agentStatus', id, status: 'active' });
          agentLastActivity.set(id, Date.now());
        }
      }

      // Update main agent activity for any non-subagent tool call
      if (mainAgentId !== null && !isSubagentTool(event.name)) {
        const activity = getActivityForTool(event.name);
        const mappedName = mapToolName(event.name);
        dispatchToWebview({ type: 'agentStatus', id: mainAgentId, status: 'active' });
        dispatchToWebview({ type: 'agentToolUse', id: mainAgentId, tool: mappedName, activity });
        agentLastActivity.set(mainAgentId, Date.now());
      }
    } else if (event.kind === 'tool_result') {
      // Check if this result corresponds to a pending subagent
      const toolUseId = event.toolUseId;
      if (toolUseId && pendingAgentToolUseIds.has(toolUseId)) {
        pendingAgentToolUseIds.delete(toolUseId);
        const id = subagentIds.get(toolUseId);
        if (id !== undefined) {
          dispatchToWebview({ type: 'agentStatus', id, status: 'waiting' });
          scheduleSubagentClose(toolUseId, id);
        }
      }
    }
  }
}

function scheduleSubagentClose(toolUseId: string, id: number): void {
  const label = subagentLabels.get(toolUseId) ?? toolUseId;
  setTimeout(() => {
    dispatchToWebview({ type: 'agentClosed', id });
    subagentIds.delete(toolUseId);
    subagentLabels.delete(toolUseId);
    sessionToAgent.delete(`subagent:${toolUseId}`);
    agentToSession.delete(id);
    agentLastActivity.delete(id);
    console.log(`[Adapter] Subagent closed: "${label}" (${toolUseId}) → agent ${id}`);
  }, 5000);
}

// ── Idle detection timer ─────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setInterval> | null = null;

function startIdleDetection(): void {
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, lastActive] of agentLastActivity) {
      if (now - lastActive > IDLE_TIMEOUT_MS) {
        dispatchToWebview({ type: 'agentStatus', id, status: 'waiting' });
      }
    }
  }, 3000);
}

function stopIdleDetection(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

// ── Status change handler ───────────────────────────────────────────────

let statusChangeCallback: ((connected: boolean) => void) | null = null;

export function onConnectionStatusChange(cb: (connected: boolean) => void): void {
  statusChangeCallback = cb;
}

// ── Main adapter ────────────────────────────────────────────────────────

let poller: OpenClawPoller | null = null;
let transcriptWatcher: TranscriptWatcher | null = null;

export function startAdapter(): () => void {
  // Handle outbound messages from the UI
  const unsubOutbound = onOutboundMessage((msg) => {
    const type = msg.type as string;

    if (type === 'webviewReady') {
      void loadInitialState();
    } else if (type === 'focusAgent') {
      console.log('[Adapter] focusAgent:', msg.id);
    } else if (type === 'closeAgent') {
      console.log('[Adapter] closeAgent:', msg.id);
    } else if (type === 'saveLayout') {
      try {
        localStorage.setItem('openclaw-pixel-agents-layout', JSON.stringify(msg.layout));
      } catch (e) {
        console.warn('[Adapter] Failed to save layout:', e);
      }
    } else if (type === 'saveAgentSeats') {
      try {
        localStorage.setItem('openclaw-pixel-agents-seats', JSON.stringify(msg.seats));
      } catch (e) {
        console.warn('[Adapter] Failed to save seats:', e);
      }
    } else if (type === 'setSoundEnabled') {
      try {
        localStorage.setItem('openclaw-pixel-agents-sound', JSON.stringify(msg.enabled));
      } catch (e) {
        console.warn('[Adapter] Failed to save sound setting:', e);
      }
    } else if (type === 'exportLayout') {
      exportLayout();
    } else if (type === 'importLayout') {
      importLayout();
    }
  });

  // Start polling for session updates
  poller = createPoller(handleSessionUpdate, (connected) => {
    statusChangeCallback?.(connected);
  });
  poller.start();

  // Create transcript watcher (started once we know the transcript path)
  transcriptWatcher = createTranscriptWatcher(handleTranscriptEvents);

  // Start idle detection
  startIdleDetection();

  return () => {
    unsubOutbound();
    poller?.stop();
    poller = null;
    transcriptWatcher?.stop();
    transcriptWatcher = null;
    stopIdleDetection();
  };
}

// ── Initial state loading ───────────────────────────────────────────────

async function loadInitialState(): Promise<void> {
  try {
    const sessions = await listSessions(50, 120);
    const agentIds: number[] = [];
    const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};

    // Load persisted seat data
    let savedSeats: Record<string, { palette?: number; hueShift?: number; seatId?: string }> = {};
    try {
      const raw = localStorage.getItem('openclaw-pixel-agents-seats');
      if (raw) savedSeats = JSON.parse(raw) as typeof savedSeats;
    } catch { /* ignore */ }

    for (const session of sessions) {
      const id = getOrCreateAgentId(session.key);
      agentIds.push(id);
      knownSessions.set(session.key, session);
      if (savedSeats[id]) {
        agentMeta[id] = savedSeats[id];
      }
    }

    // Send existing agents with display names as folder labels
    const folderNames: Record<number, string> = {};
    for (const session of sessions) {
      const id = sessionToAgent.get(session.key);
      if (id !== undefined && session.displayName) {
        folderNames[id] = session.displayName;
      }
    }

    dispatchToWebview({
      type: 'existingAgents',
      agents: agentIds,
      agentMeta,
      folderNames,
    });

    // Load persisted layout
    let layout = null;
    try {
      const raw = localStorage.getItem('openclaw-pixel-agents-layout');
      if (raw) layout = JSON.parse(raw);
    } catch { /* ignore */ }

    dispatchToWebview({
      type: 'layoutLoaded',
      layout,
      wasReset: false,
    });

    // Load settings
    try {
      const raw = localStorage.getItem('openclaw-pixel-agents-sound');
      const soundEnabled = raw !== null ? (JSON.parse(raw) as boolean) : true;
      dispatchToWebview({ type: 'settingsLoaded', soundEnabled });
    } catch { /* ignore */ }
  } catch (e) {
    console.warn('[Adapter] Failed to load initial state:', e);
    // Still send layout so the UI isn't stuck on "Loading..."
    let layout = null;
    try {
      const raw = localStorage.getItem('openclaw-pixel-agents-layout');
      if (raw) layout = JSON.parse(raw);
    } catch { /* ignore */ }
    dispatchToWebview({ type: 'layoutLoaded', layout, wasReset: false });
  }
}

// ── Polling session update handler ──────────────────────────────────────

function handleSessionUpdate(sessions: OpenClawSession[]): void {
  const currentKeys = new Set(sessions.map((s) => s.key));
  const previousKeys = new Set(knownSessions.keys());

  // Detect new sessions
  for (const session of sessions) {
    if (!previousKeys.has(session.key)) {
      const id = getOrCreateAgentId(session.key);
      const folderName = session.displayName ?? session.key;
      dispatchToWebview({ type: 'agentCreated', id, folderName });
      console.log(`[Adapter] New session detected: ${session.key} → agent ${id}`);
    }
    knownSessions.set(session.key, session);
  }

  // Track main agent and start transcript watcher for the first session
  if (sessions.length > 0 && mainAgentId === null) {
    const first = sessions[0];
    mainAgentId = sessionToAgent.get(first.key) ?? null;
  }
  // Start transcript watcher on first session with a transcriptPath
  if (transcriptWatcher && !transcriptWatcher.watching) {
    const sessionWithTranscript = sessions.find((s) => s.transcriptPath);
    if (sessionWithTranscript?.transcriptPath) {
      console.log(`[Adapter] Starting transcript watcher: ${sessionWithTranscript.transcriptPath}`);
      transcriptWatcher.start(sessionWithTranscript.transcriptPath);
    }
  }

  // Detect removed sessions
  for (const key of previousKeys) {
    if (!currentKeys.has(key)) {
      const id = sessionToAgent.get(key);
      if (id !== undefined) {
        dispatchToWebview({ type: 'agentClosed', id });
        sessionToAgent.delete(key);
        agentToSession.delete(id);
        agentLastActivity.delete(id);
        console.log(`[Adapter] Session removed: ${key} → agent ${id}`);
      }
      knownSessions.delete(key);
    }
  }

  // Update activity states based on updatedAt changes
  // Only use updatedAt as fallback — transcript watcher provides more granular status
  const now = Date.now();
  for (const session of sessions) {
    const id = sessionToAgent.get(session.key);
    if (id === undefined) continue;

    // Skip if transcript watcher recently updated this agent
    const lastTranscriptActivity = agentLastActivity.get(id);
    if (lastTranscriptActivity && now - lastTranscriptActivity < IDLE_TIMEOUT_MS) continue;

    const updatedAt = session.updatedAt ?? 0;
    const ageMs = now - updatedAt;

    if (ageMs < 10000) {
      dispatchToWebview({ type: 'agentStatus', id, status: 'active' });
    } else {
      dispatchToWebview({ type: 'agentStatus', id, status: 'waiting' });
    }
  }
}

// ── Export/Import Layout ────────────────────────────────────────────────

function exportLayout(): void {
  try {
    const raw = localStorage.getItem('openclaw-pixel-agents-layout');
    if (!raw) {
      console.warn('[Adapter] No layout to export');
      return;
    }
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pixel-agents-layout.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('[Adapter] Export failed:', e);
  }
}

function importLayout(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const layout = JSON.parse(reader.result as string) as Record<string, unknown>;
        if (layout.version !== 1 || !Array.isArray(layout.tiles)) {
          console.warn('[Adapter] Invalid layout file');
          return;
        }
        localStorage.setItem('openclaw-pixel-agents-layout', JSON.stringify(layout));
        dispatchToWebview({ type: 'layoutLoaded', layout, wasReset: false });
      } catch (e) {
        console.warn('[Adapter] Import failed:', e);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}
