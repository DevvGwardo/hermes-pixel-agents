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
