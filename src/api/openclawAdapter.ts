/**
 * OpenClaw Adapter — maps OpenClaw Gateway sessions to the pixel-agents message format.
 * Uses polling via /tools/invoke to track sessions and their activity.
 */

import {
  createPoller,
  getSessionHistory,
  listSessions,
  type OpenClawPoller,
  type OpenClawSession,
} from './openclawClient.js';
import { dispatchToWebview, onOutboundMessage } from '../messageBus.js';
import { waitForAssets } from './assetLoader.js';

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
  kimi_delegate: 'Task',
  kimi_research: 'Task',
  image: 'WebFetch',
  memory_search: 'Grep',
  memory_get: 'Read',
  web_search_brave: 'WebSearch',
  cron: 'Bash',
  session_status: 'Read',
  process: 'Bash',
};

/** Map an OpenClaw tool name to the pixel-agents display name */
export function mapToolName(openclawTool: string): string {
  const lower = openclawTool.toLowerCase();
  if (TOOL_NAME_MAP[lower]) return TOOL_NAME_MAP[lower];
  // Handle MCP-prefixed tool names (e.g. mcp__kimi__kimi_delegate → kimi_delegate)
  if (lower.startsWith('mcp__')) {
    const parts = lower.split('__');
    const baseName = parts[parts.length - 1];
    if (TOOL_NAME_MAP[baseName]) return TOOL_NAME_MAP[baseName];
  }
  return openclawTool;
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

/** Maps tool_use id → agent ID for active subagent tasks */
const subagentIds = new Map<string, number>();
/** Maps tool_use id → display label for subagents */
const subagentLabels = new Map<string, string>();
/** Tracks pending Agent tool_use IDs that haven't completed yet */
const pendingAgentToolUseIds = new Set<string>();
/** Pool of idle subagent character IDs per parent agent, available for reuse */
const idleSubagentPool = new Map<number, number[]>();
/** Maps subagent character ID → parent agent ID (for recycling) */
const subagentParent = new Map<number, number>();
/** Tracks the last tool activity time per agent ID */
const agentLastActivity = new Map<number, number>();
/** Tracks the last dispatched status per agent to avoid duplicate dispatches */
const agentLastStatus = new Map<number, string>();
/** The main (first) session's agent ID, set once sessions come in */
let mainAgentId: number | null = null;
/** Tracks the last seen updatedAt per session key, to detect genuine activity changes */
const sessionLastUpdatedAt = new Map<string, number>();

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
  process: 'running',
  web_search: 'searching',
  web_fetch: 'searching',
  web_search_brave: 'searching',
  sessions_spawn: 'spawning',
  agent: 'spawning',
  task: 'spawning',
  kimi_delegate: 'spawning',
  kimi_research: 'searching',
};

/** Normalize MCP-prefixed tool names to their base name (e.g. mcp__kimi__kimi_delegate → kimi_delegate) */
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
  const basename = (p: unknown) => (typeof p === 'string' ? p.split(/[/\\]/).pop() ?? p : '');
  const normalized = normalizeToolName(toolName);
  switch (normalized) {
    case 'read':
      return `Reading ${basename(input.file_path ?? input.path)}`;
    case 'write':
      return `Writing ${basename(input.file_path ?? input.path)}`;
    case 'edit':
      return `Editing ${basename(input.file_path ?? input.path)}`;
    case 'exec':
    case 'bash': {
      const cmd = (input.command as string) ?? '';
      return `Running: ${cmd.length > 40 ? cmd.slice(0, 37) + '…' : cmd}`;
    }
    case 'web_search':
    case 'web_search_brave':
      return `Searching: ${(input.query as string)?.slice(0, 30) ?? 'web'}`;
    case 'web_fetch':
      return `Fetching: ${basename(input.url)}`;
    case 'sessions_spawn':
      return `Spawning: ${(input.task as string)?.slice(0, 30) ?? 'subagent'}`;
    case 'kimi_delegate':
      return `Delegating: ${(input.description as string)?.slice(0, 30) ?? (input.task as string)?.slice(0, 30) ?? 'Kimi task'}`;
    case 'kimi_research':
      return `Researching: ${(input.query as string)?.slice(0, 30) ?? (input.topic as string)?.slice(0, 30) ?? 'Kimi research'}`;
    case 'memory_search':
      return `Searching memory`;
    case 'image':
      return 'Analyzing image';
    case 'cron':
      return 'Managing cron job';
    default:
      return `Using ${mapToolName(toolName)}`;
  }
}

// ── History-based tool detection ─────────────────────────────────────────

/** Tool names that indicate subagent spawning (case-insensitive match) */
const SUBAGENT_TOOL_NAMES = new Set([
  'agent', 'task', 'sessions_spawn', 'sessions_send',
  'kimi_delegate',
]);

/** Patterns in tool names that indicate delegation/subagent work */
const SUBAGENT_TOOL_PATTERNS = ['_delegate'];

function isSubagentTool(name: string): boolean {
  const lower = name.toLowerCase();
  if (SUBAGENT_TOOL_NAMES.has(lower)) return true;
  // Check normalized name (strips mcp__ prefix)
  const normalized = normalizeToolName(name);
  if (SUBAGENT_TOOL_NAMES.has(normalized)) return true;
  // Also match delegation patterns in the full name
  for (const pattern of SUBAGENT_TOOL_PATTERNS) {
    if (lower.includes(pattern)) return true;
  }
  return false;
}

/** Set of tool_use IDs we've already processed, to avoid duplicates */
const seenToolUseIds = new Set<string>();

/** Extract tool call info from a content block, handling both Claude and OpenClaw formats.
 *  Claude format:  { type: "tool_use", id, name, input }
 *  OpenClaw format: { type: "toolCall", id, name, arguments }
 */
function extractToolCall(block: Record<string, unknown>): {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
} | null {
  if (block.type === 'tool_use' || block.type === 'toolCall') {
    const toolUseId = block.id as string | undefined;
    if (!toolUseId) return null;
    const toolName = block.name as string;
    // "input" (Claude) or "arguments" (OpenClaw)
    const input = ((block.input ?? block.arguments) as Record<string, unknown>) ?? {};
    return { toolUseId, toolName, input };
  }
  return null;
}

/** Extract tool result ID from a content block or message, handling both formats.
 *  Claude format:  { type: "tool_result", tool_use_id }
 *  OpenClaw format: message with { role: "toolResult", toolCallId }
 */
function extractToolResultId(block: Record<string, unknown>): string | null {
  if (block.type === 'tool_result') {
    return (block.tool_use_id as string) ?? null;
  }
  // OpenClaw native format: { type: "toolResult", toolCallId }
  if (block.type === 'toolResult') {
    return (block.toolCallId as string) ?? (block.tool_use_id as string) ?? null;
  }
  return null;
}

/**
 * Poll session history and process new tool_use blocks for a given session.
 */
async function pollHistoryForSession(sessionKey: string, agentId: number | null): Promise<void> {
  try {
    const messages = await getSessionHistory(sessionKey, 40, true);
    const ownerAgentId = agentId ?? mainAgentId;

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        const b = block as Record<string, unknown>;
        const toolCall = extractToolCall(b);
        if (!toolCall) continue;

        const { toolUseId, toolName, input } = toolCall;
        if (seenToolUseIds.has(toolUseId)) continue;
        seenToolUseIds.add(toolUseId);

        // Detect subagent spawning from tool_use blocks.
        // Session-based detection (`:subagent:` keys in session list) is the primary
        // path. History detection is a fallback for cases where tool_use appears
        // before the session is visible, and also tracks the tool_use → tool_result
        // lifecycle for activity status.
        if (isSubagentTool(toolName)) {
          const label =
            (input.description as string) ??
            (input.label as string) ??
            (input.task as string)?.slice(0, 40) ??
            'subagent';

          if (!subagentIds.has(toolUseId)) {
            // Check if a session-based subagent already exists for this parent.
            // If so, just track the tool_use ID for completion detection — don't create
            // a duplicate character.
            const parentId = ownerAgentId ?? mainAgentId ?? 0;
            const parentSession = agentToSession.get(parentId);
            let sessionSubagentId: number | undefined;
            if (parentSession) {
              // Collect IDs already linked to a tool_use to avoid double-linking
              const alreadyLinked = new Set<number>();
              for (const linkedId of subagentIds.values()) {
                alreadyLinked.add(linkedId);
              }
              // Look for any :subagent: session under this parent that hasn't been linked yet
              for (const [key, id] of sessionToAgent) {
                if (key.startsWith(parentSession.replace(':main', '')) && key.includes(':subagent:')) {
                  if (!alreadyLinked.has(id) && agentLastActivity.has(id)) {
                    sessionSubagentId = id;
                    break;
                  }
                }
              }
            }

            if (sessionSubagentId !== undefined) {
              // Session already created the character — just track the tool lifecycle
              subagentIds.set(toolUseId, sessionSubagentId);
              subagentLabels.set(toolUseId, label);
              pendingAgentToolUseIds.add(toolUseId);
              agentLastActivity.set(sessionSubagentId, Date.now());
              console.log(`[Adapter] Subagent tool linked to session character: "${label}" (${toolUseId}) → agent ${sessionSubagentId}`);
            } else {
              // No session found — create subagent character via the parent's agentToolStart
              // with "Subtask:" prefix. This triggers useExtensionMessages → os.addSubagent()
              // which creates the character as a proper subagent (near parent, with parent palette).
              subagentIds.set(toolUseId, parentId);
              subagentLabels.set(toolUseId, label);
              pendingAgentToolUseIds.add(toolUseId);

              agentLastStatus.set(parentId, 'active');
              dispatchToWebview({ type: 'agentStatus', id: parentId, status: 'active' });
              dispatchToWebview({
                type: 'agentToolStart',
                id: parentId,
                toolId: toolUseId,
                status: `Subtask: ${label}`,
              });
              agentLastActivity.set(parentId, Date.now());
              console.log(`[Adapter] Subagent spawned (history→Subtask): "${label}" (${toolUseId}) on parent ${parentId}`);
            }
          }
        }

        // Update owning agent activity for non-subagent tool calls
        if (ownerAgentId !== null && !isSubagentTool(toolName)) {
          const activity = getActivityForTool(toolName);
          const mappedName = mapToolName(toolName);
          agentLastStatus.set(ownerAgentId, 'active');
          dispatchToWebview({ type: 'agentStatus', id: ownerAgentId, status: 'active' });
          dispatchToWebview({ type: 'agentToolUse', id: ownerAgentId, tool: mappedName, activity });
          // Show tool name as overlay label above character
          const statusText = formatToolStatus(toolName, input);
          dispatchToWebview({
            type: 'agentToolStart',
            id: ownerAgentId,
            toolId: toolUseId,
            status: statusText,
          });
          agentLastActivity.set(ownerAgentId, Date.now());
        }
      }

      // Check for tool_result blocks in assistant content to detect subagent completion
      for (const block of content) {
        const b = block as Record<string, unknown>;
        const resultId = extractToolResultId(b);
        if (resultId && pendingAgentToolUseIds.has(resultId)) {
          completeSubagentTool(resultId);
        }
      }
    }

    // Check toolResult role messages (OpenClaw native format: role="toolResult", toolCallId)
    // and tool role messages (Claude format: role="tool")
    for (const msg of messages) {
      const m = msg as unknown as Record<string, unknown>;
      if (msg.role === 'toolResult') {
        // OpenClaw native format
        const toolCallId = m.toolCallId as string | undefined;
        if (toolCallId && pendingAgentToolUseIds.has(toolCallId)) {
          completeSubagentTool(toolCallId);
        }
      } else if (msg.role === 'tool') {
        // Claude format
        const content = msg.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const b = block as Record<string, unknown>;
          const toolUseId = (b.tool_use_id as string) ?? (b.id as string);
          if (toolUseId && pendingAgentToolUseIds.has(toolUseId)) {
            completeSubagentTool(toolUseId);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[Adapter] History poll failed for ${sessionKey}:`, err);
  }
}


/** Handle subagent tool completion — clean up character and tracking state */
function completeSubagentTool(toolUseId: string): void {
  pendingAgentToolUseIds.delete(toolUseId);
  const parentId = subagentIds.get(toolUseId);
  if (parentId === undefined) return;

  const label = subagentLabels.get(toolUseId) ?? toolUseId;

  // Check if this was a session-based subagent (has its own agent ID) or
  // a history-based subagent (tracked via parent's Subtask: tool)
  const isSessionBased = subagentParent.has(parentId);

  if (isSessionBased) {
    // Session-based: parentId is actually the subagent's own ID
    agentLastStatus.set(parentId, 'waiting');
    dispatchToWebview({ type: 'agentStatus', id: parentId, status: 'waiting' });
    recycleSubagent(toolUseId, parentId);
  } else {
    // History-based: parentId is the actual parent agent — dispatch subagentClear
    // to remove the subagent character created via "Subtask:" agentToolStart
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
    console.log(`[Adapter] Subagent completed (history): "${label}" (${toolUseId}) on parent ${parentId}`);
  }
}

function recycleSubagent(toolUseId: string, id: number): void {
  const label = subagentLabels.get(toolUseId) ?? toolUseId;
  const parentId = subagentParent.get(id) ?? mainAgentId ?? 0;

  // Clean up the tool_use mapping
  subagentIds.delete(toolUseId);
  subagentLabels.delete(toolUseId);
  pendingAgentToolUseIds.delete(toolUseId);

  // Session-based subagents (with their own :subagent: session) are managed by
  // the session lifecycle — don't pool them. Only pool history-created subagents.
  const sessionKey = agentToSession.get(id);
  if (sessionKey && sessionKey.includes(':subagent:')) {
    console.log(`[Adapter] Subagent idle (session-managed): "${label}" (${toolUseId}) → agent ${id}`);
    return;
  }

  // Add to idle pool for this parent (history-created subagents only)
  const pool = idleSubagentPool.get(parentId);
  if (pool) {
    pool.push(id);
  } else {
    idleSubagentPool.set(parentId, [id]);
  }

  console.log(`[Adapter] Subagent idle (pooled): "${label}" (${toolUseId}) → agent ${id}`);
}

// ── Idle detection timer ─────────────────────────────────────────────────

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

let poller: OpenClawPoller | null = null;

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

  // Start idle detection
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
  // Wait for all assets (characters, furniture, floors, walls) to load
  // before sending layout + agents, so desks are recognized as seats
  await waitForAssets();

  try {
    const sessions = await listSessions(50);
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
      knownSessions.set(session.key, session);
      agentIds.push(id);
      if (savedSeats[id]) {
        // Keep palette/hueShift but omit seatId — let findFreeSeat assign desk seats
        agentMeta[id] = {
          palette: savedSeats[id].palette,
          hueShift: savedSeats[id].hueShift,
        };
      }
      // Track parent for subagent sessions
      if (session.key.includes(':subagent:')) {
        const parts = session.key.split(':subagent:');
        const parentKey = parts[0] + ':main';
        const parentId = sessionToAgent.get(parentKey);
        if (parentId !== undefined) {
          subagentParent.set(id, parentId);
        }
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

    // Load persisted layout, falling back to default layout
    let layout = null;
    let defaultLayout = null;
    try {
      const raw = localStorage.getItem('openclaw-pixel-agents-layout');
      if (raw) layout = JSON.parse(raw);
    } catch { /* ignore */ }

    // Always fetch the default layout to check for revision updates
    try {
      const res = await fetch('./assets/default-layout-1.json');
      if (res.ok) defaultLayout = await res.json();
    } catch { /* ignore */ }

    // Use default if no saved layout, or if default has a newer revision
    if (!layout || (defaultLayout && (defaultLayout.layoutRevision ?? 0) > (layout.layoutRevision ?? 0))) {
      if (defaultLayout) {
        layout = defaultLayout;
        localStorage.setItem('openclaw-pixel-agents-layout', JSON.stringify(layout));
        console.log('[Adapter] Loaded default layout (revision ' + (layout.layoutRevision ?? 0) + ')');
      }
    }

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

function handleSessionUpdate(sessions: OpenClawSession[]): void {
  const currentKeys = new Set(sessions.map((s) => s.key));
  const previousKeys = new Set(knownSessions.keys());

  // Detect new sessions
  for (const session of sessions) {
    if (!previousKeys.has(session.key)) {
      const id = getOrCreateAgentId(session.key);
      const isSubagent = session.key.includes(':subagent:');
      const folderName = session.displayName ?? session.key;
      dispatchToWebview({ type: 'agentCreated', id, folderName });

      if (isSubagent) {
        const parts = session.key.split(':subagent:');
        const parentKey = parts[0] + ':main';
        const parentId = sessionToAgent.get(parentKey);
        // Track parent relationship for cleanup
        if (parentId !== undefined) {
          subagentParent.set(id, parentId);
        }
        agentLastStatus.set(id, 'active');
        dispatchToWebview({ type: 'agentStatus', id, status: 'active' });
        agentLastActivity.set(id, Date.now());
        console.log(
          `[Adapter] Subagent session detected: ${session.key} → agent ${id} (parent: ${parentKey} → ${parentId ?? 'unknown'})`,
        );
      } else {
        console.log(`[Adapter] New session detected: ${session.key} → agent ${id}`);
      }
    }
    knownSessions.set(session.key, session);
  }

  // Track main agent (first non-subagent session)
  if (sessions.length > 0 && mainAgentId === null) {
    const mainSession = sessions.find((s) => !s.key.includes(':subagent:')) ?? sessions[0];
    mainAgentId = sessionToAgent.get(mainSession.key) ?? null;
  }

  // Poll history for all recently active sessions to detect tool usage
  const now2 = Date.now();
  for (const session of sessions) {
    const updatedAt = session.updatedAt ?? 0;
    // Poll sessions updated in the last 60 seconds
    if (now2 - updatedAt > 60_000) continue;

    const agentId = sessionToAgent.get(session.key) ?? null;
    // Fire and forget — don't block the update loop
    void pollHistoryForSession(session.key, agentId);
  }

  // Detect removed sessions
  for (const key of previousKeys) {
    if (!currentKeys.has(key)) {
      const id = sessionToAgent.get(key);
      if (id !== undefined) {
        // Close any pooled idle subagents for this parent (non-subagent sessions only)
        if (!key.includes(':subagent:')) {
          const pool = idleSubagentPool.get(id);
          if (pool) {
            for (const subId of pool) {
              dispatchToWebview({ type: 'agentClosed', id: subId });
              agentLastActivity.delete(subId);
              agentLastStatus.delete(subId);
              subagentParent.delete(subId);
            }
            idleSubagentPool.delete(id);
          }
        }
        dispatchToWebview({ type: 'agentClosed', id });
        sessionToAgent.delete(key);
        agentToSession.delete(id);
        agentLastActivity.delete(id);
        agentLastStatus.delete(id);
        subagentParent.delete(id);
        console.log(`[Adapter] Session removed: ${key} → agent ${id}`);
      }
      knownSessions.delete(key);
      sessionLastUpdatedAt.delete(key);
    }
  }

  // Update activity states based on updatedAt changes
  // Only use updatedAt as fallback — history polling provides more granular status.
  // Only transition to 'active' when updatedAt actually changes (genuine new activity),
  // not just because the timestamp is recent — prevents flip-flop with idle timer.
  const now = Date.now();
  for (const session of sessions) {
    const id = sessionToAgent.get(session.key);
    if (id === undefined) continue;

    // Skip if history polling recently updated this agent
    const lastTranscriptActivity = agentLastActivity.get(id);
    if (lastTranscriptActivity && now - lastTranscriptActivity < IDLE_TIMEOUT_MS) continue;

    const updatedAt = session.updatedAt ?? 0;
    const prevUpdatedAt = sessionLastUpdatedAt.get(session.key) ?? 0;
    sessionLastUpdatedAt.set(session.key, updatedAt);

    const ageMs = now - updatedAt;

    // Use a longer idle threshold for subagent sessions — they may have gaps
    // between tool calls while the LLM is thinking
    const isSubagent = session.key.includes(':subagent:');
    const idleThreshold = isSubagent ? 30_000 : 10_000;

    // Only mark active if updatedAt genuinely changed since last poll
    const hasNewActivity = updatedAt > prevUpdatedAt;
    const newStatus = (hasNewActivity && ageMs < idleThreshold) ? 'active' : 'waiting';
    if (agentLastStatus.get(id) !== newStatus) {
      agentLastStatus.set(id, newStatus);
      dispatchToWebview({ type: 'agentStatus', id, status: newStatus });
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
