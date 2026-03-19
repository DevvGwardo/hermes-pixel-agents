import { useEffect, useRef, useState } from 'react';

import { CHARACTER_SITTING_OFFSET_PX, CHARACTER_Z_SORT_OFFSET } from '../../constants.js';
import type { OfficeState } from '../engine/officeState.js';
import type { ToolActivity } from '../types.js';
import { CharacterState, TILE_SIZE } from '../types.js';

/** Approximate character sprite dimensions in world pixels */
const CHAR_SPRITE_W = 16;
const CHAR_SPRITE_H = 32;

interface ActivityLine {
  id: number;
  agentId: number;
  text: string;
  timestamp: number;
}

const MAX_LINES = 6;
const LINE_LIFETIME_MS = 15000;
let nextLineId = 1;

interface WallMonitorProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  /** Tile position of the monitor on the map */
  tileCol: number;
  tileRow: number;
  /** Width in tiles */
  widthTiles?: number;
  /** Height in tiles */
  heightTiles?: number;
}

export function WallMonitor({
  officeState,
  agents,
  agentTools,
  containerRef,
  zoom,
  panRef,
  tileCol,
  tileRow,
  widthTiles = 6,
  heightTiles = 4,
}: WallMonitorProps) {
  const [lines, setLines] = useState<ActivityLine[]>([]);
  const [, setTick] = useState(0);
  const prevToolsRef = useRef<string>('');

  // Track tool changes and add new lines.
  // Build a fingerprint from ALL tools (active + done) so we detect
  // completions even when the tool finishes between poll cycles.
  useEffect(() => {
    const toolSummary: string[] = [];
    for (const agentId of agents) {
      const tools = agentTools[agentId];
      if (!tools) continue;
      for (const t of tools) {
        toolSummary.push(`${agentId}:${t.toolId}:${t.status}:${t.done}`);
      }
    }
    const key = toolSummary.join('|');
    if (key === prevToolsRef.current || key === '') return;
    prevToolsRef.current = key;

    // Show the latest tool status per agent (active preferred, else last completed)
    const newLines: ActivityLine[] = [];
    for (const agentId of agents) {
      const tools = agentTools[agentId];
      if (!tools || tools.length === 0) continue;
      const activeTool = [...tools].reverse().find((t) => !t.done);
      const tool = activeTool ?? tools[tools.length - 1];
      if (tool) {
        const ch = officeState.characters.get(agentId);
        const name = ch?.folderName
          ? ch.folderName.replace(/^webchatsg-/, '').slice(0, 12)
          : `#${agentId}`;
        newLines.push({
          id: nextLineId++,
          agentId,
          text: `${name} > ${tool.status}`,
          timestamp: Date.now(),
        });
      }
    }

    if (newLines.length > 0) {
      setLines((prev) => [...newLines, ...prev].slice(0, MAX_LINES));
    }
  }, [agents, agentTools, officeState]);

  // Build live status lines from character state when no tool activity lines exist.
  // This ensures the monitor always shows something useful.
  const statusLines: { id: number; text: string; isActive: boolean }[] = [];
  if (lines.length === 0) {
    const chars = Array.from(officeState.characters.values());
    let subCount = 0;
    for (const ch of chars) {
      if (ch.isSubagent) {
        subCount++;
        continue;
      }
      const name = ch.folderName
        ? ch.folderName.replace(/^webchatsg-/, '').slice(0, 14)
        : `Agent #${ch.id}`;
      const status = ch.isActive ? 'working' : 'idle';
      statusLines.push({ id: ch.id, text: `${name} — ${status}`, isActive: ch.isActive });
    }
    if (subCount > 0) {
      statusLines.push({ id: -1, text: `${subCount} subagent${subCount > 1 ? 's' : ''} active`, isActive: true });
    }
    // Cap to avoid overflow
    statusLines.splice(MAX_LINES);
  }

  // Clean up old lines
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setLines((prev) => prev.filter((l) => now - l.timestamp < LINE_LIFETIME_MS));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // RAF for position updates
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;

  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(rect.width * dpr);
  const canvasH = Math.round(rect.height * dpr);
  const layout = officeState.getLayout();
  const mapW = layout.cols * TILE_SIZE * zoom;
  const mapH = layout.rows * TILE_SIZE * zoom;
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x);
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y);

  // Position at tile coordinates
  const worldX = tileCol * TILE_SIZE;
  const worldY = tileRow * TILE_SIZE;
  const screenX = (deviceOffsetX + worldX * zoom) / dpr;
  const screenY = (deviceOffsetY + worldY * zoom) / dpr;
  const screenW = (widthTiles * TILE_SIZE * zoom) / dpr;
  const screenH = (heightTiles * TILE_SIZE * zoom) / dpr;

  // Build clip-path with holes for characters that should render in front.
  // The monitor's z-sort Y is its top world Y. Characters with a higher
  // z-sort Y (further down the screen) should appear in front.
  const monitorZY = tileRow * TILE_SIZE;
  const holes: string[] = [];
  const pad = 1; // small pixel padding so edges aren't razor-tight
  for (const [, ch] of officeState.characters) {
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;
    if (charZY <= monitorZY) continue; // character is behind monitor

    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    // Character screen position (anchor: bottom-center)
    const chScrX = (deviceOffsetX + ch.x * zoom) / dpr;
    const chScrY = (deviceOffsetY + (ch.y + sittingOffset) * zoom) / dpr;
    const cw = (CHAR_SPRITE_W * zoom) / dpr;
    const ch_ = (CHAR_SPRITE_H * zoom) / dpr;

    // Bounding box in screen coords (top-left based)
    const cx = chScrX - cw / 2;
    const cy = chScrY - ch_;

    // Relative to the monitor element
    const relX = cx - screenX;
    const relY = cy - screenY;

    // Check overlap with monitor bounds
    if (relX >= screenW || relX + cw <= 0 || relY >= screenH || relY + ch_ <= 0) continue;

    // Clamp to monitor bounds
    const x1 = Math.max(0, relX) - pad;
    const y1 = Math.max(0, relY) - pad;
    const x2 = Math.min(screenW, relX + cw) + pad;
    const y2 = Math.min(screenH, relY + ch_) + pad;

    holes.push(`M${x1} ${y1}H${x2}V${y2}H${x1}Z`);
  }

  const bracketW = Math.max(4, screenW * 0.025);
  const bracketH = Math.max(8, screenH * 0.35);
  const mountBarH = Math.max(3, screenH * 0.06);
  const outerW = screenW + (bracketW + 2) * 2;
  const outerH = screenH + mountBarH + 4;

  // Rebuild clip-path holes relative to the outer wrapper (shifted by bracket offset)
  const clipPath =
    holes.length > 0
      ? `path(evenodd,"M0 0H${outerW}V${outerH}H0Z ${holes.map((h) => {
          // Offset hole coords by bracketW+2, mountBarH
          return h.replace(/M([\d.e-]+) ([\d.e-]+)H([\d.e-]+)V([\d.e-]+)H[\d.e-]+Z/,
            (_, x1, y1, x2, y2) =>
              `M${Number(x1) + bracketW + 2} ${Number(y1) + mountBarH}H${Number(x2) + bracketW + 2}V${Number(y2) + mountBarH}H${Number(x1) + bracketW + 2}Z`
          );
        }).join(' ')}")`
      : undefined;

  return (
    <div
      style={{
        position: 'absolute',
        left: screenX - bracketW - 2,
        top: screenY - mountBarH,
        width: outerW,
        height: outerH,
        pointerEvents: 'none',
        zIndex: 40,
        clipPath,
      }}
    >
      <style>{`
        @keyframes wall-monitor-scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100%); }
        }
        @keyframes wall-monitor-line-in {
          0% { opacity: 0; transform: translateY(-8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .wall-monitor-line {
          animation: wall-monitor-line-in 0.3s ease-out forwards;
        }
      `}</style>

      {/* Top mounting bar */}
      <div
        style={{
          position: 'absolute',
          left: bracketW + 2,
          top: 0,
          width: screenW,
          height: mountBarH,
          background: 'linear-gradient(180deg, #5a6a7a, #3a4a5a)',
          borderRadius: '1px 1px 0 0',
          boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
        }}
      />

      {/* Left bracket */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: mountBarH,
          width: bracketW,
          height: bracketH,
          background: 'linear-gradient(90deg, #4a5a6a, #3a4a5a)',
          borderRadius: '2px 0 0 2px',
          boxShadow: '-1px 1px 2px rgba(0,0,0,0.3)',
        }}
      />
      {/* Left bracket inner lip */}
      <div
        style={{
          position: 'absolute',
          left: bracketW,
          top: mountBarH,
          width: 2,
          height: bracketH,
          background: '#2a3a4a',
        }}
      />

      {/* Right bracket */}
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: mountBarH,
          width: bracketW,
          height: bracketH,
          background: 'linear-gradient(270deg, #4a5a6a, #3a4a5a)',
          borderRadius: '0 2px 2px 0',
          boxShadow: '1px 1px 2px rgba(0,0,0,0.3)',
        }}
      />
      {/* Right bracket inner lip */}
      <div
        style={{
          position: 'absolute',
          right: bracketW,
          top: mountBarH,
          width: 2,
          height: bracketH,
          background: '#2a3a4a',
        }}
      />

      {/* Bottom mounting feet — two small pegs */}
      <div
        style={{
          position: 'absolute',
          left: bracketW + 2 + screenW * 0.2,
          bottom: 0,
          width: Math.max(3, screenW * 0.04),
          height: 4,
          background: '#4a5a6a',
          borderRadius: '0 0 1px 1px',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: bracketW + 2 + screenW * 0.2,
          bottom: 0,
          width: Math.max(3, screenW * 0.04),
          height: 4,
          background: '#4a5a6a',
          borderRadius: '0 0 1px 1px',
        }}
      />

      {/* Monitor screen */}
      <div
        style={{
          position: 'absolute',
          left: bracketW + 2,
          top: mountBarH,
          width: screenW,
          height: screenH,
          background: 'rgba(5, 15, 25, 0.92)',
          border: '2px solid #2a4a6a',
          borderTop: '3px solid #3a5a7a',
          borderRadius: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 0 12px rgba(60, 140, 255, 0.2), inset 0 0 30px rgba(0, 20, 40, 0.5)',
        }}
      >
        {/* Title bar */}
        <div
          style={{
            padding: '3px 6px',
            borderBottom: '1px solid #1a3a5a',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: '#5ac88c',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: Math.max(10, screenH * 0.1) + 'px',
              color: '#5a8cff',
              letterSpacing: '1.5px',
              textTransform: 'uppercase',
              fontWeight: 'bold',
            }}
          >
            Live Activity
          </span>
        </div>

        {/* Content area */}
        <div
          style={{
            flex: 1,
            padding: '3px 6px',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {lines.length === 0 && statusLines.length === 0 && (
            <div
              style={{
                color: '#2a4a3a',
                fontSize: Math.max(7, screenH * 0.07) + 'px',
                padding: '4px 0',
              }}
            >
              No agents online
            </div>
          )}
          {lines.length === 0 && statusLines.map((sl) => (
            <div
              key={sl.id}
              style={{
                fontSize: Math.max(10, screenH * 0.11) + 'px',
                color: sl.isActive ? '#a0f0c8' : '#70b898',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                lineHeight: 1.5,
                textShadow: sl.isActive ? '0 0 4px rgba(140,255,180,0.3)' : 'none',
              }}
            >
              {sl.isActive ? '\u25CF' : '\u25CB'} {sl.text}
            </div>
          ))}
          {lines.map((line) => {
            const age = Date.now() - line.timestamp;
            const opacity = age > LINE_LIFETIME_MS - 3000
              ? Math.max(0.15, 1 - (age - (LINE_LIFETIME_MS - 3000)) / 3000)
              : 1;
            return (
              <div
                key={line.id}
                className="wall-monitor-line"
                style={{
                  fontSize: Math.max(7, screenH * 0.07) + 'px',
                  color: `rgba(140, 220, 180, ${opacity})`,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  lineHeight: 1.4,
                }}
              >
                {line.text}
              </div>
            );
          })}
        </div>

        {/* Scanline effect */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.06) 2px, rgba(0,0,0,0.06) 4px)',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}
