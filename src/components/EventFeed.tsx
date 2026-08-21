import type { FeedEvent } from '../hooks/useEventFeed.js';

export function EventFeed({ events }: { events: FeedEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        pointerEvents: 'none',
        maxWidth: 320,
      }}
    >
      <style>{`
        @keyframes pixel-event-slide-in {
          0% { opacity: 0; transform: translateX(40px); }
          100% { opacity: 1; transform: translateX(0); }
        }
        @keyframes pixel-event-fade-out {
          0% { opacity: 1; }
          100% { opacity: 0; }
        }
        .pixel-event-item {
          animation: pixel-event-slide-in 0.25s ease-out forwards;
        }
      `}</style>
      {events.map((event) => (
        <div
          key={event.id}
          className="pixel-event-item"
          style={{
            background: 'rgba(30, 30, 46, 0.88)',
            border: '2px solid var(--pixel-border)',
            padding: '5px 10px',
            fontSize: '18px',
            color: 'var(--pixel-text)',
            boxShadow: 'var(--pixel-shadow)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {event.text}
        </div>
      ))}
    </div>
  );
}
