/**
 * OpenClaw Adapter — maps OpenClaw Gateway events to the pixel-agents message format.
 * Bridges the OpenClaw API client with the webview message bus.
 */

import {
  connectWebSocket,
  fetchSessionHistory,
  fetchSessions,
  type OpenClawConnection,
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
};

function mapToolName(openclawTool: string): string {
  const lower = openclawTool.toLowerCase();
  return TOOL_NAME_MAP[lower] ?? openclawTool;
}

// ── Session → Agent ID mapping ──────────────────────────────────────────

let nextAgentId = 1;
let nextSubagentId = -1;
const sessionToAgent = new Map<string, number>();
const agentToSession = new Map<number, string>();
const subagentToParent = new Map<number, { parentId: number; parentToolId: string }>();

function getOrCreateAgentId(sessionKey: string): number {
  let id = sessionToAgent.get(sessionKey);
  if (id === undefined) {
    id = nextAgentId++;
    sessionToAgent.set(sessionKey, id);
    agentToSession.set(id, sessionKey);
  }
  return id;
}

function createSubagentId(parentSessionKey: string, parentToolId: string): number {
  const parentId = sessionToAgent.get(parentSessionKey);
  if (parentId === undefined) return nextSubagentId--;
  const id = nextSubagentId--;
  subagentToParent.set(id, { parentId, parentToolId });
  return id;
}

// ── Status change handler ───────────────────────────────────────────────

let statusChangeCallback: ((connected: boolean) => void) | null = null;

export function onConnectionStatusChange(cb: (connected: boolean) => void): void {
  statusChangeCallback = cb;
}

// ── Main adapter ────────────────────────────────────────────────────────

let connection: OpenClawConnection | null = null;

export function startAdapter(): () => void {
  // Handle outbound messages from the UI
  const unsubOutbound = onOutboundMessage((msg) => {
    const type = msg.type as string;

    if (type === 'webviewReady') {
      // Initial load — fetch sessions and send them as existing agents
      void loadInitialState();
    } else if (type === 'focusAgent') {
      // In standalone mode, focusing an agent is a no-op (no terminal to focus)
      console.log('[Adapter] focusAgent:', msg.id);
    } else if (type === 'closeAgent') {
      console.log('[Adapter] closeAgent:', msg.id);
    } else if (type === 'saveLayout') {
      // Persist to localStorage
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

  // Connect WebSocket for real-time events
  connection = connectWebSocket(handleWsEvent, (connected) => {
    statusChangeCallback?.(connected);
    if (connected) {
      // Re-sync sessions on reconnect
      void loadInitialState();
    }
  });

  return () => {
    unsubOutbound();
    connection?.close();
    connection = null;
  };
}

// ── Initial state loading ───────────────────────────────────────────────

async function loadInitialState(): Promise<void> {
  try {
    const sessions = await fetchSessions();
    const agentIds: number[] = [];
    const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};

    // Load persisted seat data
    let savedSeats: Record<string, { palette?: number; hueShift?: number; seatId?: string }> = {};
    try {
      const raw = localStorage.getItem('openclaw-pixel-agents-seats');
      if (raw) savedSeats = JSON.parse(raw) as typeof savedSeats;
    } catch { /* ignore */ }

    for (const session of sessions) {
      if (session.parentKey) continue; // Skip sub-sessions for now
      const id = getOrCreateAgentId(session.key);
      agentIds.push(id);
      if (savedSeats[id]) {
        agentMeta[id] = savedSeats[id];
      }
    }

    // Send existing agents
    dispatchToWebview({
      type: 'existingAgents',
      agents: agentIds,
      agentMeta,
      folderNames: {},
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
      const soundEnabled = raw !== null ? JSON.parse(raw) as boolean : true;
      dispatchToWebview({ type: 'settingsLoaded', soundEnabled });
    } catch { /* ignore */ }

    // Replay active tool states from history
    for (const session of sessions) {
      if (session.parentKey) continue;
      if (session.status === 'thinking' || session.status === 'tool-calling') {
        void replaySessionTools(session.key);
      }
    }
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

async function replaySessionTools(sessionKey: string): Promise<void> {
  try {
    const history = await fetchSessionHistory(sessionKey);
    const agentId = sessionToAgent.get(sessionKey);
    if (agentId === undefined) return;

    // Find most recent active tool from history
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.type === 'tool_use' && entry.data) {
        const toolName = mapToolName(entry.data.tool as string ?? 'unknown');
        dispatchToWebview({
          type: 'agentToolStart',
          id: agentId,
          toolId: entry.data.id as string ?? `tool-${i}`,
          status: toolName,
        });
        break;
      }
    }
  } catch (e) {
    console.warn(`[Adapter] Failed to replay tools for ${sessionKey}:`, e);
  }
}

// ── WebSocket event handler ─────────────────────────────────────────────

function handleWsEvent(event: Record<string, unknown>): void {
  const eventType = event.type as string;
  const sessionKey = event.session_key as string | undefined;

  if (!sessionKey) return;

  switch (eventType) {
    case 'session_created': {
      const parentKey = event.parent_key as string | undefined;
      if (parentKey) {
        // Sub-agent
        const parentToolId = (event.tool_id as string) ?? `subtask-${sessionKey}`;
        const subId = createSubagentId(parentKey, parentToolId);
        const parentId = sessionToAgent.get(parentKey);
        if (parentId !== undefined) {
          const label = (event.label as string) ?? 'Subtask';
          dispatchToWebview({
            type: 'agentToolStart',
            id: parentId,
            toolId: parentToolId,
            status: `Subtask: ${label}`,
          });
        }
        sessionToAgent.set(sessionKey, subId);
      } else {
        const id = getOrCreateAgentId(sessionKey);
        dispatchToWebview({ type: 'agentCreated', id });
      }
      break;
    }

    case 'session_ended': {
      const id = sessionToAgent.get(sessionKey);
      if (id === undefined) return;
      const sub = subagentToParent.get(id);
      if (sub) {
        dispatchToWebview({
          type: 'subagentClear',
          id: sub.parentId,
          parentToolId: sub.parentToolId,
        });
        dispatchToWebview({
          type: 'agentToolDone',
          id: sub.parentId,
          toolId: sub.parentToolId,
        });
        subagentToParent.delete(id);
      } else {
        dispatchToWebview({ type: 'agentClosed', id });
      }
      sessionToAgent.delete(sessionKey);
      agentToSession.delete(id);
      break;
    }

    case 'tool_start': {
      const id = sessionToAgent.get(sessionKey);
      if (id === undefined) return;
      const toolName = mapToolName((event.tool as string) ?? 'unknown');
      const toolId = (event.tool_id as string) ?? `tool-${Date.now()}`;
      const sub = subagentToParent.get(id);
      if (sub) {
        dispatchToWebview({
          type: 'subagentToolStart',
          id: sub.parentId,
          parentToolId: sub.parentToolId,
          toolId,
          status: toolName,
        });
      } else {
        dispatchToWebview({
          type: 'agentToolStart',
          id,
          toolId,
          status: toolName,
        });
      }
      break;
    }

    case 'tool_end': {
      const id = sessionToAgent.get(sessionKey);
      if (id === undefined) return;
      const toolId = (event.tool_id as string) ?? '';
      const sub = subagentToParent.get(id);
      if (sub) {
        dispatchToWebview({
          type: 'subagentToolDone',
          id: sub.parentId,
          parentToolId: sub.parentToolId,
          toolId,
        });
      } else {
        dispatchToWebview({
          type: 'agentToolDone',
          id,
          toolId,
        });
      }
      break;
    }

    case 'session_status': {
      const id = sessionToAgent.get(sessionKey);
      if (id === undefined) return;
      const status = event.status as string;
      if (status === 'idle' || status === 'complete') {
        dispatchToWebview({ type: 'agentToolsClear', id });
        dispatchToWebview({ type: 'agentStatus', id, status: 'waiting' });
      } else if (status === 'thinking' || status === 'tool-calling') {
        dispatchToWebview({ type: 'agentStatus', id, status: 'active' });
      } else if (status === 'waiting_for_permission') {
        dispatchToWebview({ type: 'agentToolPermission', id });
      }
      break;
    }

    case 'turn_end': {
      const id = sessionToAgent.get(sessionKey);
      if (id === undefined) return;
      dispatchToWebview({ type: 'agentToolsClear', id });
      dispatchToWebview({ type: 'agentStatus', id, status: 'waiting' });
      break;
    }

    default:
      console.log('[Adapter] Unhandled WS event:', eventType, event);
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
