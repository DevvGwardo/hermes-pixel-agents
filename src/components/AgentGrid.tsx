import { useEffect, useRef, useState } from 'react';

import type { OfficeState } from '../office/engine/officeState.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import { getCharacterSprites } from '../office/sprites/spriteData.js';
import type { Character, ToolActivity } from '../office/types.js';
import { CharacterState, Direction } from '../office/types.js';

interface AgentGridProps {
  officeState: OfficeState;
  agentTools: Record<number, ToolActivity[]>;
  isOpen: boolean;
  onClose: () => void;
}

const SPRITE_ZOOM = 4;
const GRID_COLS = 6;
const TOOLTIP_OFFSET = 14;
const CARD_WIDTH = 120;

function getActivityText(
  ch: Character,
  agentTools: Record<number, ToolActivity[]>,
): string {
  const tools = agentTools[ch.id];
  if (tools && tools.length > 0) {
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    if (ch.isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }
  if (ch.currentTool) return `Using ${ch.currentTool}`;
  return ch.isActive ? 'Working...' : 'Idle';
}

function getStatusColor(ch: Character, agentTools: Record<number, ToolActivity[]>): string {
  const tools = agentTools[ch.id];
  const hasPermission = tools?.some((t) => t.permissionWait && !t.done);
  if (hasPermission || ch.bubbleType === 'permission') return 'var(--pixel-status-permission)';
  if (ch.isActive) return 'var(--pixel-status-active)';
  return 'rgba(255,255,255,0.25)';
}

function getStatusLabel(ch: Character, agentTools: Record<number, ToolActivity[]>): string {
  const tools = agentTools[ch.id];
  const hasPermission = tools?.some((t) => t.permissionWait && !t.done);
  if (hasPermission || ch.bubbleType === 'permission') return 'Needs Approval';
  if (ch.isActive) return 'Active';
  if (ch.bubbleType === 'waiting') return 'Finished';
  return 'Idle';
}

function getCharacterAction(ch: Character): string {
  switch (ch.state) {
    case CharacterState.TYPE: return 'Typing';
    case CharacterState.WALK: return 'Walking';
    default: return 'Standing';
  }
}

function getToolStats(ch: Character, agentTools: Record<number, ToolActivity[]>) {
  const tools = agentTools[ch.id] ?? [];
  const done = tools.filter((t) => t.done).length;
  const active = tools.filter((t) => !t.done).length;
  return { total: tools.length, done, active };
}

/** Renders a character sprite to a small canvas */
function SpriteCanvas({ character, size }: { character: Character; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const displayW = size ?? 32;
  const displayH = displayW * 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sprites = getCharacterSprites(character.palette, character.hueShift);
    const spriteData = sprites.walk[Direction.DOWN][0];
    const cached = getCachedSprite(spriteData, SPRITE_ZOOM);

    canvas.width = cached.width;
    canvas.height = cached.height;
    ctx.clearRect(0, 0, cached.width, cached.height);
    ctx.drawImage(cached, 0, 0);
  }, [character.palette, character.hueShift]);

  return (
    <canvas
      ref={canvasRef}
      style={{ imageRendering: 'pixelated', width: displayW, height: displayH }}
    />
  );
}

/** Scrolling marquee text for names that overflow */
function Marquee({ text, style }: { text: string; style?: React.CSSProperties }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    setOverflows(inner.scrollWidth > outer.clientWidth + 2);
  }, [text]);

  return (
    <div
      ref={outerRef}
      style={{
        overflow: 'hidden',
        width: '100%',
        whiteSpace: 'nowrap',
        textAlign: 'center',
        maskImage: overflows
          ? 'linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)'
          : undefined,
        WebkitMaskImage: overflows
          ? 'linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)'
          : undefined,
        ...style,
      }}
    >
      <span
        ref={innerRef}
        className={overflows ? 'agent-grid-marquee' : undefined}
        style={{
          display: 'inline-block',
          paddingRight: overflows ? 32 : 0,
        }}
      >
        {text}
        {overflows && (
          <span style={{ paddingLeft: 32 }} aria-hidden>
            {text}
          </span>
        )}
      </span>
    </div>
  );
}

/** Small inline badge */
function Badge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span
      style={{
        fontSize: '14px',
        color,
        background: bg,
        padding: '1px 5px',
        borderRadius: 0,
        border: `1px solid ${color}30`,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

/** Floating tooltip that follows the mouse */
function Tooltip({
  character,
  agentTools,
  officeState,
  mouseX,
  mouseY,
}: {
  character: Character;
  agentTools: Record<number, ToolActivity[]>;
  officeState: OfficeState;
  mouseX: number;
  mouseY: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: mouseX, y: mouseY });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = mouseX + TOOLTIP_OFFSET;
    let y = mouseY + TOOLTIP_OFFSET;
    if (x + rect.width > window.innerWidth - 8) x = mouseX - rect.width - TOOLTIP_OFFSET;
    if (y + rect.height > window.innerHeight - 8) y = mouseY - rect.height - TOOLTIP_OFFSET;
    setPos({ x, y });
  }, [mouseX, mouseY]);

  const name = character.folderName
    ? character.folderName.replace(/^webchatsg-/, '')
    : `Agent #${character.id}`;
  const activity = getActivityText(character, agentTools);
  const statusColor = getStatusColor(character, agentTools);
  const statusLabel = getStatusLabel(character, agentTools);
  const action = getCharacterAction(character);
  const toolStats = getToolStats(character, agentTools);

  // Find parent name if subagent
  let parentName: string | null = null;
  if (character.isSubagent && character.parentAgentId != null) {
    const parent = officeState.characters.get(character.parentAgentId);
    parentName = parent?.folderName
      ? parent.folderName.replace(/^webchatsg-/, '').slice(0, 20)
      : `Agent #${character.parentAgentId}`;
  }

  // Count subagents of this character
  let subCount = 0;
  if (!character.isSubagent) {
    for (const ch of officeState.characters.values()) {
      if (ch.parentAgentId === character.id) subCount++;
    }
  }

  const dimText: React.CSSProperties = { fontSize: '16px', color: 'rgba(255,255,255,0.45)' };
  const valText: React.CSSProperties = { fontSize: '16px', color: 'var(--pixel-text)' };

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 70,
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border-light)',
        borderRadius: 0,
        boxShadow: '4px 4px 0px #0a0a14, 0 0 16px rgba(90,140,255,0.15)',
        padding: 0,
        pointerEvents: 'none',
        minWidth: 220,
        maxWidth: 320,
      }}
    >
      {/* Header strip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: '1px solid var(--pixel-border)',
          background: 'rgba(255,255,255,0.03)',
        }}
      >
        <SpriteCanvas character={character} size={20} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Marquee
            text={name}
            style={{ fontSize: '20px', color: 'var(--pixel-text)', fontWeight: 'bold', textAlign: 'left' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: statusColor,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: '16px', color: statusColor, fontWeight: 'bold' }}>
              {statusLabel}
            </span>
          </div>
        </div>
      </div>

      {/* Data rows */}
      <div style={{ padding: '6px 12px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {/* Current activity */}
        <div style={{ display: 'flex', alignItems: 'space-between', gap: 8 }}>
          <span style={{ ...dimText, flexShrink: 0 }}>Activity</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Marquee
              text={activity}
              style={{
                ...valText,
                color: character.isActive ? '#a0f0c8' : 'var(--pixel-text-dim)',
                textAlign: 'right',
              }}
            />
          </div>
        </div>

        {/* Character state */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={dimText}>State</span>
          <span style={valText}>{action}</span>
        </div>

        {/* Current tool */}
        {character.currentTool && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ ...dimText, flexShrink: 0 }}>Tool</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Marquee
                text={character.currentTool}
                style={{ ...valText, color: 'var(--pixel-accent)', textAlign: 'right' }}
              />
            </div>
          </div>
        )}

        {/* Tool stats */}
        {toolStats.total > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={dimText}>Tools</span>
            <span style={valText}>
              {toolStats.active > 0 && (
                <span style={{ color: 'var(--pixel-status-active)' }}>{toolStats.active} running</span>
              )}
              {toolStats.active > 0 && toolStats.done > 0 && ', '}
              {toolStats.done > 0 && (
                <span style={{ color: 'var(--pixel-green)' }}>{toolStats.done} done</span>
              )}
            </span>
          </div>
        )}

        {/* Seat */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={dimText}>Seat</span>
          <span style={valText}>{character.seatId ? 'Assigned' : 'Unassigned'}</span>
        </div>

        {/* Position */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={dimText}>Position</span>
          <span style={valText}>({character.tileCol}, {character.tileRow})</span>
        </div>

        {/* ID */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={dimText}>ID</span>
          <span style={{ ...dimText, fontFamily: 'monospace' }}>#{character.id}</span>
        </div>

        {/* Subagent info */}
        {parentName && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ ...dimText, flexShrink: 0 }}>Parent</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Marquee
                text={parentName}
                style={{ ...valText, color: 'var(--pixel-green)', textAlign: 'right' }}
              />
            </div>
          </div>
        )}

        {/* Subagent count for main agents */}
        {!character.isSubagent && subCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={dimText}>Subagents</span>
            <span style={{ ...valText, color: 'var(--pixel-green)' }}>{subCount}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentGrid({ officeState, agentTools, isOpen, onClose }: AgentGridProps) {
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const allChars = Array.from(officeState.characters.values());
  const mainAgents = allChars.filter((ch) => !ch.isSubagent);
  const subAgents = allChars.filter((ch) => ch.isSubagent);
  const hoveredChar = hoveredId !== null ? officeState.characters.get(hoveredId) ?? null : null;

  const handleMouseMove = (e: React.MouseEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
  };

  const renderCard = (ch: Character) => {
    const isHovered = hoveredId === ch.id;
    const name = ch.folderName
      ? ch.folderName.replace(/^webchatsg-/, '')
      : `Agent #${ch.id}`;
    const statusColor = getStatusColor(ch, agentTools);
    const statusLabel = getStatusLabel(ch, agentTools);
    const action = getCharacterAction(ch);

    return (
      <div
        key={ch.id}
        onMouseEnter={() => setHoveredId(ch.id)}
        onMouseLeave={() => setHoveredId(null)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 3,
          padding: '8px 6px 6px',
          background: isHovered ? 'var(--pixel-btn-hover-bg)' : 'var(--pixel-btn-bg)',
          border: isHovered
            ? '2px solid var(--pixel-accent)'
            : '2px solid var(--pixel-border)',
          borderRadius: 0,
          cursor: 'default',
          transition: 'background 0.1s, border-color 0.1s',
          width: CARD_WIDTH,
          position: 'relative',
          boxSizing: 'border-box',
        }}
      >
        {/* Top-right status dot */}
        <span
          style={{
            position: 'absolute',
            top: 5,
            right: 5,
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: statusColor,
          }}
        />

        <SpriteCanvas character={ch} />

        {/* Name — marquee scrolls if it overflows */}
        <Marquee
          text={name}
          style={{ fontSize: '17px', color: 'var(--pixel-text)' }}
        />

        {/* Status + action row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            justifyContent: 'center',
            width: '100%',
          }}
        >
          <span style={{ fontSize: '14px', color: statusColor, fontWeight: 'bold' }}>
            {statusLabel}
          </span>
          <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.3)' }}>
            {action}
          </span>
        </div>

        {/* Current tool badge */}
        {ch.currentTool && (
          <Badge
            label={ch.currentTool}
            color="var(--pixel-accent)"
            bg="rgba(90,140,255,0.12)"
          />
        )}
      </div>
    );
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          zIndex: 60,
        }}
      />

      {/* Marquee animation */}
      <style>{`
        @keyframes agent-grid-marquee-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .agent-grid-marquee {
          animation: agent-grid-marquee-scroll 6s linear infinite;
        }
      `}</style>

      {/* Modal */}
      <div
        onMouseMove={handleMouseMove}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 61,
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: 'var(--pixel-shadow)',
          maxWidth: '90vw',
          maxHeight: '85vh',
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '2px solid var(--pixel-border)',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: '26px', color: 'var(--pixel-text)', fontWeight: 'bold' }}>
            Agent Roster
          </span>
          <span style={{ fontSize: '20px', color: 'var(--pixel-text-dim)', marginLeft: 12 }}>
            {mainAgents.length} agent{mainAgents.length !== 1 ? 's' : ''}
            {subAgents.length > 0 &&
              ` + ${subAgents.length} sub${subAgents.length !== 1 ? 's' : ''}`}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--pixel-close-text)',
              cursor: 'pointer',
              fontSize: '28px',
              lineHeight: 1,
              padding: '0 4px',
              marginLeft: 16,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)';
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '12px', overflow: 'auto' }}>
          {mainAgents.length > 0 && (
            <>
              <div
                style={{
                  fontSize: '20px',
                  color: 'var(--pixel-accent)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                }}
              >
                Agents
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${Math.min(GRID_COLS, mainAgents.length)}, ${CARD_WIDTH}px)`,
                  gap: 6,
                  marginBottom: subAgents.length > 0 ? 16 : 0,
                }}
              >
                {mainAgents.map((ch) => renderCard(ch))}
              </div>
            </>
          )}

          {subAgents.length > 0 && (
            <>
              <div
                style={{
                  fontSize: '20px',
                  color: 'var(--pixel-green)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                }}
              >
                Subagents
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${Math.min(GRID_COLS, subAgents.length)}, ${CARD_WIDTH}px)`,
                  gap: 6,
                }}
              >
                {subAgents.map((ch) => renderCard(ch))}
              </div>
            </>
          )}

          {allChars.length === 0 && (
            <div
              style={{
                padding: '24px 0',
                textAlign: 'center',
                fontSize: '22px',
                color: 'var(--pixel-text-dim)',
              }}
            >
              No agents online
            </div>
          )}
        </div>
      </div>

      {/* Floating tooltip that follows mouse */}
      {hoveredChar && (
        <Tooltip
          character={hoveredChar}
          agentTools={agentTools}
          officeState={officeState}
          mouseX={mousePos.x}
          mouseY={mousePos.y}
        />
      )}
    </>
  );
}
