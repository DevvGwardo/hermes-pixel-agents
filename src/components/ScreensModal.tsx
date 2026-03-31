import { useCallback, useEffect, useState } from 'react';

import {
  createScreenId,
  getScreens,
  saveScreens,
  type ScreenConfig,
} from '../screenSettings.js';

interface ScreensModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScreensChanged: () => void;
}

/** Extract a YouTube video ID from a URL or plain ID string */
function parseYoutubeInput(input: string): string {
  const trimmed = input.trim();
  // Already a bare ID (11 chars, no slashes)
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    // youtube.com/watch?v=ID
    const v = url.searchParams.get('v');
    if (v) return v;
    // youtu.be/ID or youtube.com/embed/ID
    const parts = url.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /^[\w-]{11}$/.test(last)) return last;
  } catch {
    // not a URL
  }
  return trimmed;
}

function youtubeThumb(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
}

const CARD_W = 220;
const GRID_COLS = 4;

export function ScreensModal({ isOpen, onClose, onScreensChanged }: ScreensModalProps) {
  const [screens, setScreens] = useState<ScreenConfig[]>(() => getScreens());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newUrl, setNewUrl] = useState('');

  // Sync from localStorage when opened
  useEffect(() => {
    if (isOpen) setScreens(getScreens());
  }, [isOpen]);

  const persist = useCallback(
    (next: ScreenConfig[]) => {
      setScreens(next);
      saveScreens(next);
      onScreensChanged();
    },
    [onScreensChanged],
  );

  const handleToggle = useCallback(
    (id: string) => {
      persist(screens.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
    },
    [screens, persist],
  );

  const handleRemove = useCallback(
    (id: string) => {
      persist(screens.filter((s) => s.id !== id));
      if (editingId === id) setEditingId(null);
    },
    [screens, persist, editingId],
  );

  const handleStartEdit = useCallback(
    (s: ScreenConfig) => {
      setEditingId(s.id);
      setEditLabel(s.label);
      setEditUrl(s.youtubeVideoId);
    },
    [],
  );

  const handleSaveEdit = useCallback(() => {
    if (!editingId) return;
    const videoId = parseYoutubeInput(editUrl);
    persist(
      screens.map((s) =>
        s.id === editingId ? { ...s, label: editLabel || 'Untitled', youtubeVideoId: videoId } : s,
      ),
    );
    setEditingId(null);
  }, [editingId, editLabel, editUrl, screens, persist]);

  const handleAdd = useCallback(() => {
    const videoId = parseYoutubeInput(newUrl);
    if (!videoId) return;
    const screen: ScreenConfig = {
      id: createScreenId(),
      label: newLabel || 'New Stream',
      youtubeVideoId: videoId,
      enabled: true,
    };
    persist([...screens, screen]);
    setNewLabel('');
    setNewUrl('');
    setAddMode(false);
  }, [newLabel, newUrl, screens, persist]);

  const handleMoveUp = useCallback(
    (id: string) => {
      const idx = screens.findIndex((s) => s.id === id);
      if (idx <= 0) return;
      const next = [...screens];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      persist(next);
    },
    [screens, persist],
  );

  const handleMoveDown = useCallback(
    (id: string) => {
      const idx = screens.findIndex((s) => s.id === id);
      if (idx < 0 || idx >= screens.length - 1) return;
      const next = [...screens];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      persist(next);
    },
    [screens, persist],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingId) {
          setEditingId(null);
        } else if (addMode) {
          setAddMode(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, editingId, addMode]);

  if (!isOpen) return null;

  const enabledCount = screens.filter((s) => s.enabled).length;

  const inputStyle: React.CSSProperties = {
    background: 'rgba(0,0,0,0.4)',
    border: '2px solid var(--pixel-border)',
    borderRadius: 0,
    color: 'var(--pixel-text)',
    fontSize: '18px',
    padding: '4px 8px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  const smallBtnStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid var(--pixel-border)',
    borderRadius: 0,
    color: 'var(--pixel-text-dim)',
    fontSize: '16px',
    padding: '2px 8px',
    cursor: 'pointer',
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.7)',
          zIndex: 60,
        }}
      />

      <style>{`
        @keyframes screens-card-glow {
          0%, 100% { box-shadow: 0 0 8px rgba(90,140,255,0.2), var(--pixel-shadow); }
          50% { box-shadow: 0 0 16px rgba(90,140,255,0.5), var(--pixel-shadow); }
        }
        .screens-card-active { animation: screens-card-glow 2s ease-in-out infinite; }
        .screens-thumb-hover:hover { filter: brightness(1.2); }
      `}</style>

      {/* Modal */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 61,
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          boxShadow: '4px 4px 0px #0a0a14, 0 0 24px rgba(90,140,255,0.15)',
          maxWidth: '95vw',
          maxHeight: '90vh',
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 400,
        }}
      >
        {/* Header — game-style banner */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: '3px solid var(--pixel-accent)',
            background: 'linear-gradient(180deg, rgba(90,140,255,0.15) 0%, transparent 100%)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: '18px', color: 'var(--pixel-accent)', letterSpacing: 2 }}>
              [||]
            </span>
            <span
              style={{
                fontSize: '28px',
                color: 'var(--pixel-text)',
                fontWeight: 'bold',
                textTransform: 'uppercase',
                letterSpacing: 2,
              }}
            >
              Screen Lineup
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: '18px', color: 'var(--pixel-text-dim)' }}>
              {enabledCount}/{screens.length} ON AIR
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
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)';
              }}
            >
              X
            </button>
          </div>
        </div>

        {/* Grid */}
        <div style={{ padding: '16px', overflow: 'auto' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.min(GRID_COLS, Math.max(screens.length, 1))}, ${CARD_W}px)`,
              gap: 10,
              justifyContent: 'center',
            }}
          >
            {screens.map((s, idx) => {
              const isEditing = editingId === s.id;
              const isHovered = hoveredId === s.id;

              return (
                <div
                  key={s.id}
                  className={s.enabled && !isEditing ? 'screens-card-active' : undefined}
                  onMouseEnter={() => setHoveredId(s.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    background: isEditing
                      ? 'rgba(90,140,255,0.08)'
                      : s.enabled
                        ? 'rgba(90,200,140,0.06)'
                        : 'rgba(255,255,255,0.03)',
                    border: isEditing
                      ? '2px solid var(--pixel-accent)'
                      : s.enabled
                        ? '2px solid rgba(90,200,140,0.4)'
                        : '2px solid var(--pixel-border)',
                    borderRadius: 0,
                    overflow: 'hidden',
                    position: 'relative',
                    transition: 'border-color 0.15s, background 0.15s',
                    opacity: s.enabled ? 1 : 0.55,
                  }}
                >
                  {/* Slot number badge — game roster style */}
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      background: s.enabled ? 'var(--pixel-accent)' : 'rgba(255,255,255,0.15)',
                      color: '#fff',
                      fontSize: '14px',
                      fontWeight: 'bold',
                      padding: '2px 7px',
                      zIndex: 2,
                      letterSpacing: 1,
                    }}
                  >
                    #{idx + 1}
                  </div>

                  {/* ON AIR / OFF AIR indicator */}
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      right: 0,
                      background: s.enabled ? 'rgba(255,60,60,0.85)' : 'rgba(100,100,100,0.6)',
                      color: '#fff',
                      fontSize: '12px',
                      fontWeight: 'bold',
                      padding: '2px 6px',
                      zIndex: 2,
                      letterSpacing: 1,
                    }}
                  >
                    {s.enabled ? 'ON AIR' : 'OFF'}
                  </div>

                  {/* Thumbnail */}
                  <div
                    style={{
                      width: '100%',
                      height: 120,
                      background: '#0a0a14',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      position: 'relative',
                    }}
                  >
                    <img
                      src={youtubeThumb(s.youtubeVideoId)}
                      alt={s.label}
                      className="screens-thumb-hover"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        imageRendering: 'auto',
                        filter: s.enabled ? 'none' : 'grayscale(0.8) brightness(0.6)',
                        transition: 'filter 0.2s',
                      }}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                    {/* Scanline overlay on thumbnail */}
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background:
                          'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)',
                        pointerEvents: 'none',
                      }}
                    />
                  </div>

                  {/* Info section */}
                  <div style={{ padding: '8px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {isEditing ? (
                      /* Edit form */
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <input
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          placeholder="Label"
                          style={inputStyle}
                          autoFocus
                          onKeyDown={(e) => e.key === 'Enter' && handleSaveEdit()}
                        />
                        <input
                          value={editUrl}
                          onChange={(e) => setEditUrl(e.target.value)}
                          placeholder="YouTube URL or Video ID"
                          style={inputStyle}
                          onKeyDown={(e) => e.key === 'Enter' && handleSaveEdit()}
                        />
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            onClick={handleSaveEdit}
                            style={{
                              ...smallBtnStyle,
                              background: 'var(--pixel-accent)',
                              borderColor: 'var(--pixel-accent)',
                              color: '#fff',
                              flex: 1,
                            }}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            style={{ ...smallBtnStyle, flex: 1 }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Label */}
                        <div
                          style={{
                            fontSize: '18px',
                            color: 'var(--pixel-text)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            fontWeight: 'bold',
                          }}
                          title={s.label}
                        >
                          {s.label}
                        </div>

                        {/* Video ID */}
                        <div
                          style={{
                            fontSize: '14px',
                            color: 'rgba(255,255,255,0.35)',
                            fontFamily: 'monospace',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {s.youtubeVideoId}
                        </div>

                        {/* Action buttons */}
                        {isHovered && (
                          <div
                            style={{
                              display: 'flex',
                              gap: 4,
                              flexWrap: 'wrap',
                              marginTop: 2,
                            }}
                          >
                            <button
                              onClick={() => handleToggle(s.id)}
                              style={{
                                ...smallBtnStyle,
                                background: s.enabled
                                  ? 'rgba(255,60,60,0.15)'
                                  : 'rgba(90,200,140,0.15)',
                                borderColor: s.enabled
                                  ? 'rgba(255,60,60,0.4)'
                                  : 'rgba(90,200,140,0.4)',
                                color: s.enabled ? '#f88' : '#8f8',
                              }}
                            >
                              {s.enabled ? 'Disable' : 'Enable'}
                            </button>
                            <button onClick={() => handleStartEdit(s)} style={smallBtnStyle}>
                              Edit
                            </button>
                            <button
                              onClick={() => handleMoveUp(s.id)}
                              style={{
                                ...smallBtnStyle,
                                opacity: idx === 0 ? 0.3 : 1,
                              }}
                              disabled={idx === 0}
                            >
                              &lt;
                            </button>
                            <button
                              onClick={() => handleMoveDown(s.id)}
                              style={{
                                ...smallBtnStyle,
                                opacity: idx === screens.length - 1 ? 0.3 : 1,
                              }}
                              disabled={idx === screens.length - 1}
                            >
                              &gt;
                            </button>
                            <button
                              onClick={() => handleRemove(s.id)}
                              style={{
                                ...smallBtnStyle,
                                background: 'rgba(255,60,60,0.1)',
                                borderColor: 'rgba(255,60,60,0.3)',
                                color: '#f66',
                              }}
                            >
                              X
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Add new screen card */}
            {addMode ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  background: 'rgba(90,140,255,0.06)',
                  border: '2px dashed var(--pixel-accent)',
                  borderRadius: 0,
                  overflow: 'hidden',
                }}
              >
                {/* Placeholder thumb area */}
                <div
                  style={{
                    width: '100%',
                    height: 120,
                    background: '#0a0a14',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {newUrl ? (
                    <img
                      src={youtubeThumb(parseYoutubeInput(newUrl))}
                      alt="Preview"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                      }}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <span style={{ fontSize: '40px', color: 'rgba(255,255,255,0.1)' }}>?</span>
                  )}
                </div>

                <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="Stream name"
                    style={inputStyle}
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && newUrl && handleAdd()}
                  />
                  <input
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="YouTube URL or Video ID"
                    style={inputStyle}
                    onKeyDown={(e) => e.key === 'Enter' && newUrl && handleAdd()}
                  />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={handleAdd}
                      disabled={!newUrl.trim()}
                      style={{
                        ...smallBtnStyle,
                        background: newUrl.trim() ? 'var(--pixel-accent)' : 'rgba(255,255,255,0.05)',
                        borderColor: 'var(--pixel-accent)',
                        color: '#fff',
                        flex: 1,
                        opacity: newUrl.trim() ? 1 : 0.4,
                      }}
                    >
                      Add Screen
                    </button>
                    <button
                      onClick={() => {
                        setAddMode(false);
                        setNewLabel('');
                        setNewUrl('');
                      }}
                      style={{ ...smallBtnStyle, flex: 1 }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div
                onClick={() => setAddMode(true)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(255,255,255,0.02)',
                  border: '2px dashed var(--pixel-border)',
                  borderRadius: 0,
                  cursor: 'pointer',
                  minHeight: 200,
                  transition: 'border-color 0.15s, background 0.15s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--pixel-accent)';
                  (e.currentTarget as HTMLElement).style.background = 'rgba(90,140,255,0.06)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = 'var(--pixel-border)';
                  (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)';
                }}
              >
                <span style={{ fontSize: '40px', color: 'var(--pixel-accent)', lineHeight: 1 }}>+</span>
                <span
                  style={{
                    fontSize: '18px',
                    color: 'var(--pixel-text-dim)',
                    marginTop: 8,
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                  }}
                >
                  Add Screen
                </span>
              </div>
            )}
          </div>

          {screens.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                padding: '16px 0 0',
                fontSize: '18px',
                color: 'rgba(255,255,255,0.35)',
              }}
            >
              No screens configured. Add a YouTube stream to get started!
            </div>
          )}
        </div>
      </div>
    </>
  );
}
