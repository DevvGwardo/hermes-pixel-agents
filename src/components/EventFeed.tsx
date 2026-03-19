import { useCallback, useEffect, useRef, useState } from 'react';

export interface FeedEvent {
  id: number;
  text: string;
  timestamp: number;
}

const MAX_EVENTS = 3;
const EVENT_LIFETIME_MS = 8000;

let nextEventId = 1;

export function useEventFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const pushEvent = useCallback((text: string) => {
    const id = nextEventId++;
    const event: FeedEvent = { id, text, timestamp: Date.now() };

    setEvents((prev) => {
      const next = [event, ...prev];
      // Remove excess events beyond MAX_EVENTS
      if (next.length > MAX_EVENTS) {
        for (const removed of next.slice(MAX_EVENTS)) {
          const timer = timersRef.current.get(removed.id);
          if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(removed.id);
          }
        }
        return next.slice(0, MAX_EVENTS);
      }
      return next;
    });

    // Auto-remove after lifetime
    const timer = setTimeout(() => {
      setEvents((prev) => prev.filter((e) => e.id !== id));
      timersRef.current.delete(id);
    }, EVENT_LIFETIME_MS);
    timersRef.current.set(id, timer);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { events, pushEvent };
}

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
