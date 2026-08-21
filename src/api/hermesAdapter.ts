/**
 * Hermes Adapter — maps Hermes agent sessions to the pixel-agents message format.
 * Uses the Hermes API server (port 8642) to poll sessions and message history.
 */

import {
  createPoller,
  getSessionMessages,
  listSessions,
  type HermesPoller,
  type HermesSession,
} from './hermesClient.js';
import { dispatchToWebview, onOutboundMessage } from '../messageBus.js';
import { waitForAssets } from './assetLoader.js';

// ── Tool name mapping ───────────────────────────────────────────────────

const TOOL_NAME_MAP: Record<string, string> = {
  exec: 'Bash',
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  patch: 'Edit',
  search_files: 'Grep',
  terminal: 'Bash',
  delegate_task: 'Task',
  mcp_delegate_task: 'Task',
  minimax_delegate: 'Task',
  agentic_delegate: 'Task',
  subagent_delegate: 'Task',
  web_search: 'WebSearch',
  web_tools: 'WebFetch',
  memory: 'Read',
  memory_search: 'Grep',
  todo: 'Task',
  cronjob: 'Bash',
  process: 'Bash',
  clarify: 'Task',
};

/** Map a Hermes tool name to the pixel-agents display name */
export function mapToolName(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (TOOL_NAME_MAP[lower]) return TOOL_NAME_MAP[lower];
  // Handle MCP-prefixed tool names (e.g. mcp__some__tool_name → tool_name)
  if (lower.startsWith('mcp__')) {
    const parts = lower.split('__');
    const baseName = parts[parts.length - 1];
    if (TOOL_NAME_MAP[baseName]) return TOOL_NAME_MAP[baseName];
  }
  return toolName;
}

// ── Session → Agent ID mapping ──────────────────────────────────────────

let nextAgentId = 1;
const sessionToAgent = new Map<string, number>();
const agentToSession = new Map<number, string>();
const knownSessions = new Map<string, HermesSession>();
/** Tracks the model per agent ID */
const agentModels = new Map<number, string>();

function getOrCreateAgentId(sessionId: string): number {
  let id = sessionToAgent.get(sessionId);
  if (id === undefined) {
    id = nextAgentId++;
    sessionToAgent.set(sessionId, id);
    agentToSession.set(id, sessionId);
  }
  return id;
}

// ── Subagent tracking ────────────────────────────────────────────────────

const subagentIds = new Map<string, number>();
const subagentLabels = new Map<string, string>();
const pendingAgentToolUseIds = new Set<string>();
const idleSubagentPool = new Map<number, number[]>();
const subagentParent = new Map<number, number>();
const agentLastActivity = new Map<number, number>();
const agentLastStatus = new Map<number, string>();
let mainAgentId: number | null = null;
const sessionLastUpdatedAt = new Map<string, number>();

const IDLE_TIMEOUT_MS = 10_000;

// ── Tool → animation category mapping ────────────────────────────────────

type ActivityCategory = 'typing' | 'reading' | 'running' | 'searching' | 'spawning';

const TOOL_ACTIVITY: Record<string, ActivityCategory> = {
  write_file: 'typing',
  patch: 'typing',
  read_file: 'reading',
  search_files: 'reading',
  memory_search: 'reading',
  terminal: 'running',
  exec: 'running',
  bash: 'running',
  cronjob: 'running',
  process: 'running',
  web_search: 'searching',
  web_tools: 'searching',
  delegate_task: 'spawning',
  minimax_delegate: 'spawning',
  mcp_delegate_task: 'spawning',
  agentic_delegate: 'spawning',
  subagent_delegate: 'spawning',
  clarify: 'spawning',
  memory: 'reading',
};

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith('mcp__')) {
    const parts = lower.split('__');
    return parts[parts.length - 1];
  }
  return lower;
}

function getActivityForTool(toolName: string): ActivityCategory {
  const normalized = normalizeToolName(toolName);
  return TOOL_ACTIVITY[normalized] ?? TOOL_ACTIVITY[toolName.toLowerCase()] ?? 'running';
}

/** Format a tool call into a human-readable status string */
function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const basename = (p: unknown) =>
    typeof p === 'string' ? p.split(/[/\\]/).pop() ?? p : '';
  const normalized = normalizeToolName(toolName);
  switch (normalized) {
    case 'read_file':
      return `Reading ${basename(input.path ?? input.file_path)}`;
    case 'write_file':
      return `Writing ${basename(input.path ?? input.file_path)}`;
    case 'patch':
      return `Editing ${basename(input.path ?? input.file_path)}`;
    case 'terminal':
    case 'exec':
    case 'bash': {
      const cmd = (input.command as string) ?? '';
      return `Running: ${cmd.length > 40 ? cmd.slice(0, 37) + '…' : cmd}`;
    }
    case 'web_search':
      return `Searching: ${(input.query as string)?.slice(0, 30) ?? 'web'}`;
    case 'web_tools':
      return `Fetching: ${basename(input.url as string)}`;
    case 'delegate_task':
    case 'minimax_delegate':
    case 'mcp_delegate_task':
    case 'agentic_delegate':
    case 'subagent_delegate':
      return `Delegating: ${(input.task as string)?.slice(0, 30) ?? (input.description as string)?.slice(0, 30) ?? 'task'}`;
    case 'memory':
      return `Searching memory`;
    case 'memory_search':
      return `Searching memory`;
    case 'clarify':
      return `Waiting for input`;
    default:
      return `Using ${mapToolName(toolName)}`;
  }
}

// ── History-based tool detection ─────────────────────────────────────────

const SUBAGENT_TOOL_NAMES = new Set([
  'delegate_task',
  'minimax_delegate',
  'mcp_delegate_task',
  'agentic_delegate',
  'subagent_delegate',
  'clarify',
]);

const SUBAGENT_TOOL_PATTERNS = ['delegate', 'subagent'];

function isSubagentTool(name: string): boolean {
  const lower = name.toLowerCase();
  if (SUBAGENT_TOOL_NAMES.has(lower)) return true;
  const normalized = normalizeToolName(name);
  if (SUBAGENT_TOOL_NAMES.has(normalized)) return true;
  for (const pattern of SUBAGENT_TOOL_PATTERNS) {
    if (lower.includes(pattern)) return true;
  }
  return false;
}

const seenToolUseIds = new Set<string>();

// Hermes uses Claude-format tool_calls on assistant messages
function extractToolCalls(
  content: unknown,
): Array<{ toolUseId: string; toolName: string; input: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  const results: Array<{ toolUseId: string; toolName: string; input: Record<string, unknown> }> = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    // Claude format: { type: "tool_use", id, name, input }
    if (b.type === 'tool_use' || b.type === 'toolCall') {
      const toolUseId = b.id as string | undefined;
      if (!toolUseId) continue;
      const toolName = b.name as string;
      const input = ((b.input ?? b.arguments) as Record<string, unknown>) ?? {};
      results.push({ toolUseId, toolName, input });
    }
    // Hermes may store tool_calls as an array on the message itself
    if (Array.isArray(b.tool_calls)) {
      for (const tc of b.tool_calls) {
        const tcBlock = tc as Record<string, unknown>;
        const toolUseId = tcBlock.id as string | undefined;
        if (!toolUseId) continue;
        const toolName = tcBlock.name as string;
        const input = (tcBlock.arguments as Record<string, unknown>) ?? {};
        results.push({ toolUseId, toolName, input });
      }
    }
  }
  return results;
}

function extractToolResultIds(
  content: unknown,
): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_result') {
      const id = (b.tool_use_id as string) ?? null;
      if (id) ids.push(id);
    }
  }
  return ids;
}

// Also check tool role messages
function extractToolResultIdsFromRole(
  messages: Array<{ role: string; content: unknown }>,
): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (typeof msg.content === 'string') {
        // content is the result text — no ID here, skip
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const b = block as Record<string, unknown>;
          const id = (b.tool_call_id as string) ?? (b.id as string) ?? null;
          if (id) ids.push(id);
        }
      }
    }
  }
  return ids;
}

async function pollHistoryForSession(
  sessionId: string,
  agentId: number | null,
): Promise<void> {
  try {
    const messages = await getSessionMessages(sessionId, 40, 0);
    const ownerAgentId = agentId ?? mainAgentId;

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const toolCalls = extractToolCalls(msg.content);
      const resultIds = extractToolResultIds(msg.content);

      for (const tc of toolCalls) {
        if (seenToolUseIds.has(tc.toolUseId)) continue;
        seenToolUseIds.add(tc.toolUseId);

        if (isSubagentTool(tc.toolName)) {
          const label =
            (tc.input.description as string) ??
            (tc.input.task as string)?.slice(0, 40) ??
            (tc.input.label as string) ??
            'subagent';

          if (!subagentIds.has(tc.toolUseId)) {
            const parentId = ownerAgentId ?? mainAgentId ?? 0;

            // Check if a session-based subagent already exists for this parent
            let sessionSubagentId: number | undefined;
            for (const [subId, mappedParent] of subagentParent) {
              if (mappedParent === parentId) {
                sessionSubagentId = subId;
                break;
              }
            }

            if (sessionSubagentId !== undefined) {
              subagentIds.set(tc.toolUseId, sessionSubagentId);
              subagentLabels.set(tc.toolUseId, label);
              pendingAgentToolUseIds.add(tc.toolUseId);
              agentLastActivity.set(sessionSubagentId, Date.now());
            } else {
              // Create via "Subtask:" agentToolStart
              subagentIds.set(tc.toolUseId, parentId);
              subagentLabels.set(tc.toolUseId, label);
              pendingAgentToolUseIds.add(tc.toolUseId);

              agentLastStatus.set(parentId, 'active');
              dispatchToWebview({ type: 'agentStatus', id: parentId, status: 'active' });
              dispatchToWebview({
                type: 'agentToolStart',
                id: parentId,
                toolId: tc.toolUseId,
                status: `Subtask: ${label}`,
              });
              agentLastActivity.set(parentId, Date.now());
            }
          }
        }

        // Normal tool activity
        if (ownerAgentId !== null && !isSubagentTool(tc.toolName)) {
          const activity = getActivityForTool(tc.toolName);
          const mappedName = mapToolName(tc.toolName);
          agentLastStatus.set(ownerAgentId, 'active');
          dispatchToWebview({ type: 'agentStatus', id: ownerAgentId, status: 'active' });
          dispatchToWebview({
            type: 'agentToolUse',
            id: ownerAgentId,
            tool: mappedName,
            activity,
          });
          const statusText = formatToolStatus(tc.toolName, tc.input);
          dispatchToWebview({
            type: 'agentToolStart',
            id: ownerAgentId,
            toolId: tc.toolUseId,
            status: statusText,
          });
          agentLastActivity.set(ownerAgentId, Date.now());
        }
      }

      // Detect tool completions
      const allResultIds = [
        ...resultIds,
        ...extractToolResultIdsFromRole(messages),
      ];
      for (const resultId of allResultIds) {
        if (pendingAgentToolUseIds.has(resultId)) {
          completeSubagentTool(resultId);
        }
      }
    }
  } catch (err) {
    console.warn(`[HermesAdapter] History poll failed for ${sessionId}:`, err);
  }
}

function completeSubagentTool(toolUseId: string): void {
  pendingAgentToolUseIds.delete(toolUseId);
  const parentId = subagentIds.get(toolUseId);
  if (parentId === undefined) return;

  const label = subagentLabels.get(toolUseId) ?? toolUseId;
  const isSessionBased = subagentParent.has(parentId);

  if (isSessionBased) {
    agentLastStatus.set(parentId, 'waiting');
    dispatchToWebview({ type: 'agentStatus', id: parentId, status: 'waiting' });
    recycleSubagent(toolUseId, parentId);
  } else {
    dispatchToWebview({
      type: 'agentToolDone',
      id: parentId,
      toolId: toolUseId,
    });
    dispatchToWebview({
      type: 'subagentClear',
      id: parentId,
      parentToolId: toolUseId,
    });
    subagentIds.delete(toolUseId);
    subagentLabels.delete(toolUseId);
    console.log(`[HermesAdapter] Subagent completed: "${label}" (${toolUseId}) on parent ${parentId}`);
  }
}

function recycleSubagent(toolUseId: string, id: number): void {
  const label = subagentLabels.get(toolUseId) ?? toolUseId;
  const parentId = subagentParent.get(id) ?? mainAgentId ?? 0;

  subagentIds.delete(toolUseId);
  subagentLabels.delete(toolUseId);
  pendingAgentToolUseIds.delete(toolUseId);

  const sessionId = agentToSession.get(id);
  // Hermes subagent sessions contain ':subagent:' in their ID
  if (sessionId && sessionId.includes(':subagent:')) {
    console.log(`[HermesAdapter] Subagent idle (session-managed): "${label}" (${toolUseId}) → agent ${id}`);
    return;
  }

  const pool = idleSubagentPool.get(parentId);
  if (pool) {
    pool.push(id);
  } else {
    idleSubagentPool.set(parentId, [id]);
  }

  console.log(`[HermesAdapter] Subagent idle (pooled): "${label}" (${toolUseId}) → agent ${id}`);
}

// ── Idle detection ─────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setInterval> | null = null;

function startIdleDetection(): void {
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, lastActive] of agentLastActivity) {
      if (now - lastActive > IDLE_TIMEOUT_MS && agentLastStatus.get(id) !== 'waiting') {
        agentLastStatus.set(id, 'waiting');
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

let poller: HermesPoller | null = null;

export function startAdapter(): () => void {
  const unsubOutbound = onOutboundMessage((msg) => {
    const type = msg.type as string;

    if (type === 'webviewReady') {
      void loadInitialState();
    } else if (type === 'focusAgent') {
      console.log('[HermesAdapter] focusAgent:', msg.id);
    } else if (type === 'closeAgent') {
      console.log('[HermesAdapter] closeAgent:', msg.id);
    } else if (type === 'saveLayout') {
      try {
        localStorage.setItem('hermes-pixel-agents-layout', JSON.stringify(msg.layout));
      } catch (e) {
        console.warn('[HermesAdapter] Failed to save layout:', e);
      }
    } else if (type === 'saveAgentSeats') {
      try {
        localStorage.setItem('hermes-pixel-agents-seats', JSON.stringify(msg.seats));
      } catch (e) {
        console.warn('[HermesAdapter] Failed to save seats:', e);
      }
    } else if (type === 'setSoundEnabled') {
      try {
        localStorage.setItem('hermes-pixel-agents-sound', JSON.stringify(msg.enabled));
      } catch (e) {
        console.warn('[HermesAdapter] Failed to save sound setting:', e);
      }
    } else if (type === 'exportLayout') {
      exportLayout();
    } else if (type === 'importLayout') {
      importLayout();
    }
  });

  poller = createPoller(handleSessionUpdate, (connected) => {
    statusChangeCallback?.(connected);
  });
  poller.start();

  startIdleDetection();

  return () => {
    unsubOutbound();
    poller?.stop();
    poller = null;
    stopIdleDetection();
  };
}

// ── Initial state loading ───────────────────────────────────────────────

async function loadInitialState(): Promise<void> {
  await waitForAssets();

  try {
    const sessions = await listSessions(50);
    const agentIds: number[] = [];
    const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};

    let savedSeats: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
    try {
      const raw = localStorage.getItem('hermes-pixel-agents-seats');
      if (raw) savedSeats = JSON.parse(raw) as typeof savedSeats;
    } catch { /* ignore */ }

    for (const session of sessions) {
      const id = getOrCreateAgentId(session.sessionId);
      knownSessions.set(session.sessionId, session);
      agentIds.push(id);
      if (savedSeats[id]) {
        agentMeta[id] = {
          palette: savedSeats[id].palette,
          hueShift: savedSeats[id].hueShift,
        };
      }
      // Detect Hermes subagent sessions (contain ':subagent:')
      if (session.sessionId.includes(':subagent:')) {
        const parts = session.sessionId.split(':subagent:');
        const parentIdRaw = parts[0];
        const parentId = sessionToAgent.get(parentIdRaw);
        if (parentId !== undefined) {
          subagentParent.set(id, parentId);
        }
      }
    }

    const folderNames: Record<number, string> = {};
    const agentModelInfo: Record<number, string> = {};
    for (const session of sessions) {
      const id = sessionToAgent.get(session.sessionId);
      if (id !== undefined) {
        if (session.title) {
          folderNames[id] = session.title;
        }
        if (session.model) {
          agentModelInfo[id] = session.model;
          agentModels.set(id, session.model);
        }
      }
    }

    dispatchToWebview({
      type: 'existingAgents',
      agents: agentIds,
      agentMeta,
      folderNames,
      agentModels: agentModelInfo,
    });

    let layout = null;
    try {
      const raw = localStorage.getItem('hermes-pixel-agents-layout');
      if (raw) layout = JSON.parse(raw);
    } catch { /* ignore */ }

    if (!layout) {
      try {
        const res = await fetch('./assets/default-layout-1.json');
        if (res.ok) layout = await res.json();
      } catch { /* ignore */ }
    }

    dispatchToWebview({ type: 'layoutLoaded', layout, wasReset: false });

    try {
      const raw = localStorage.getItem('hermes-pixel-agents-sound');
      const soundEnabled = raw !== null ? (JSON.parse(raw) as boolean) : true;
      dispatchToWebview({ type: 'settingsLoaded', soundEnabled });
    } catch { /* ignore */ }
  } catch (e) {
    console.warn('[HermesAdapter] Failed to load initial state:', e);
    let layout = null;
    try {
      const raw = localStorage.getItem('hermes-pixel-agents-layout');
      if (raw) layout = JSON.parse(raw);
    } catch { /* ignore */ }
    if (!layout) {
      try {
        const res = await fetch('./assets/default-layout-1.json');
        if (res.ok) layout = await res.json();
      } catch { /* ignore */ }
    }
    dispatchToWebview({ type: 'layoutLoaded', layout, wasReset: false });
  }
}

// ── Polling session update handler ──────────────────────────────────────

function handleSessionUpdate(sessions: HermesSession[]): void {
  const currentKeys = new Set(sessions.map((s) => s.sessionId));
  const previousKeys = new Set(knownSessions.keys());

  for (const session of sessions) {
    if (!previousKeys.has(session.sessionId)) {
      const id = getOrCreateAgentId(session.sessionId);
      const isSubagent = session.sessionId.includes(':subagent:');
      const folderName = session.title ?? session.sessionId;

      if (session.model) {
        agentModels.set(id, session.model);
      }

      dispatchToWebview({ type: 'agentCreated', id, folderName, model: session.model });

      if (isSubagent) {
        const parts = session.sessionId.split(':subagent:');
        const parentIdRaw = parts[0];
        const parentId = sessionToAgent.get(parentIdRaw);

        if (parentId !== undefined) {
          subagentParent.set(id, parentId);
          console.log(`[HermesAdapter] Subagent session: ${session.sessionId} → agent ${id} (parent: ${parentIdRaw} → ${parentId})`);
        } else {
          console.warn(`[HermesAdapter] Subagent session but parent not found: ${session.sessionId}`);
        }
        agentLastStatus.set(id, 'active');
        dispatchToWebview({ type: 'agentStatus', id, status: 'active' });
        agentLastActivity.set(id, Date.now());
      } else {
        console.log(`[HermesAdapter] New session: ${session.sessionId} → agent ${id}`);
      }
    }
    knownSessions.set(session.sessionId, session);
  }

  if (sessions.length > 0 && mainAgentId === null) {
    const mainSession = sessions.find((s) => !s.sessionId.includes(':subagent:')) ?? sessions[0];
    mainAgentId = sessionToAgent.get(mainSession.sessionId) ?? null;
  }

  // Poll history for recently active sessions
  const now2 = Date.now();
  for (const session of sessions) {
    const lastActive = session.last_active ?? 0;
    if (now2 - lastActive > 60_000) continue;

    const agentId = sessionToAgent.get(session.sessionId) ?? null;
    void pollHistoryForSession(session.sessionId, agentId);
  }

  // Detect removed sessions
  for (const key of previousKeys) {
    if (!currentKeys.has(key)) {
      const id = sessionToAgent.get(key);
      if (id !== undefined) {
        const isSubagent = key.includes(':subagent:');

        if (!isSubagent) {
          const pool = idleSubagentPool.get(id);
          if (pool) {
            for (const subId of pool) {
              dispatchToWebview({ type: 'agentFullyClosed', id: subId });
              agentLastActivity.delete(subId);
              agentLastStatus.delete(subId);
              subagentParent.delete(subId);
            }
            idleSubagentPool.delete(id);
          }
        } else {
          const nestedSubagentIds: number[] = [];
          for (const [subId, parentId] of subagentParent) {
            if (parentId === id) nestedSubagentIds.push(subId);
          }
          for (const nestedId of nestedSubagentIds) {
            dispatchToWebview({ type: 'agentFullyClosed', id: nestedId });
            agentLastActivity.delete(nestedId);
            agentLastStatus.delete(nestedId);
            subagentParent.delete(nestedId);
          }
          dispatchToWebview({ type: 'agentFullyClosed', id });
        }
        dispatchToWebview({ type: 'agentClosed', id });
        sessionToAgent.delete(key);
        agentToSession.delete(id);
        agentLastActivity.delete(id);
        agentLastStatus.delete(id);
        subagentParent.delete(id);
        console.log(`[HermesAdapter] Session removed: ${key} → agent ${id}`);
      }
      knownSessions.delete(key);
      sessionLastUpdatedAt.delete(key);
    }
  }

  // Update activity based on last_active
  const now = Date.now();
  for (const session of sessions) {
    const id = sessionToAgent.get(session.sessionId);
    if (id === undefined) continue;

    const lastTranscriptActivity = agentLastActivity.get(id);
    if (lastTranscriptActivity && now - lastTranscriptActivity < IDLE_TIMEOUT_MS) continue;

    const lastActive = session.last_active ?? 0;
    const prevUpdatedAt = sessionLastUpdatedAt.get(session.sessionId) ?? 0;
    sessionLastUpdatedAt.set(session.sessionId, lastActive);

    const ageMs = now - lastActive;
    const hasNewActivity = lastActive > prevUpdatedAt;
    const newStatus = hasNewActivity && ageMs < IDLE_TIMEOUT_MS ? 'active' : 'waiting';
    if (agentLastStatus.get(id) !== newStatus) {
      agentLastStatus.set(id, newStatus);
      dispatchToWebview({ type: 'agentStatus', id, status: newStatus });
    }
  }
}

// ── Export/Import Layout ────────────────────────────────────────────────

function exportLayout(): void {
  try {
    const raw = localStorage.getItem('hermes-pixel-agents-layout');
    if (!raw) {
      console.warn('[HermesAdapter] No layout to export');
      return;
    }
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hermes-pixel-agents-layout.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('[HermesAdapter] Export failed:', e);
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
          console.warn('[HermesAdapter] Invalid layout file');
          return;
        }
        localStorage.setItem('hermes-pixel-agents-layout', JSON.stringify(layout));
        dispatchToWebview({ type: 'layoutLoaded', layout, wasReset: false });
      } catch (e) {
        console.warn('[HermesAdapter] Import failed:', e);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}
