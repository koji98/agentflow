import { useEffect, useRef, useState } from "react";

import type { RunEvent, RunEventPage, RunSnapshot } from "../../../shared/contracts/runs";
import { mergeRunEvents } from "../lib/graph_view_model";

type StreamMode = "idle" | "loading" | "live" | "polling" | "static";

const runtimeEventTypes = [
  "graph.compiled",
  "run.preflight_failed",
  "run.started",
  "node.ready",
  "repeat.iteration.started",
  "node.started",
  "check.evaluated",
  "node.completed",
  "node.blocked",
  "node.skipped",
  "node.canceled",
  "repeat.iteration.completed",
  "run.canceled",
  "run.completed"
] as const;

function isTerminalStatus(status: RunSnapshot["run"]["status"] | undefined): boolean {
  return status === "Passed" || status === "Failed" || status === "Canceled";
}

function routePath(pathname: string): string {
  if (typeof window === "undefined") {
    return pathname;
  }

  return new URL(pathname, window.location.origin).toString();
}

async function readJson<T>(pathname: string): Promise<T> {
  const response = await fetch(routePath(pathname));

  if (!response.ok) {
    const body = await response.json().catch(() => null) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(body?.message ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export interface UseRunEventsResult {
  snapshot: RunSnapshot | null;
  events: RunEvent[];
  stream_mode: StreamMode;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useRunEvents(
  runId: string | null,
  initialSnapshot: RunSnapshot | null = null
): UseRunEventsResult {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(initialSnapshot);
  const [events, setEvents] = useState<RunEvent[]>(
    initialSnapshot ? [...initialSnapshot.recent_events].sort((left, right) => right.seq - left.seq) : []
  );
  const [streamMode, setStreamMode] = useState<StreamMode>(
    runId
      ? initialSnapshot && isTerminalStatus(initialSnapshot.run.status)
        ? "static"
        : "loading"
      : "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<number>(
    initialSnapshot
      ? Math.max(initialSnapshot.snapshot_seq, ...initialSnapshot.recent_events.map((event) => event.seq))
      : 0
  );

  async function refreshSnapshot(): Promise<void> {
    if (!runId) {
      return;
    }

    const nextSnapshot = await readJson<RunSnapshot>(`/api/runs/${encodeURIComponent(runId)}`);
    const nextCursor = Math.max(
      nextSnapshot.snapshot_seq,
      ...nextSnapshot.recent_events.map((event) => event.seq)
    );

    cursorRef.current = nextCursor;
    setSnapshot(nextSnapshot);
    setEvents((current) => mergeRunEvents(current, nextSnapshot.recent_events));
    setStreamMode(isTerminalStatus(nextSnapshot.run.status) ? "static" : "loading");
    setError(null);
  }

  useEffect(() => {
    if (!runId) {
      setSnapshot(null);
      setEvents([]);
      setStreamMode("idle");
      setError(null);
      cursorRef.current = 0;
      return;
    }

    let active = true;
    setStreamMode(initialSnapshot && initialSnapshot.run.run_id === runId && !isTerminalStatus(initialSnapshot.run.status)
      ? "loading"
      : initialSnapshot && initialSnapshot.run.run_id === runId
        ? "static"
        : "loading");

    void refreshSnapshot().catch((nextError: unknown) => {
      if (!active) {
        return;
      }

      setError(nextError instanceof Error ? nextError.message : "Unable to read run snapshot.");
      setStreamMode("static");
    });

    return () => {
      active = false;
    };
  }, [initialSnapshot, runId]);

  useEffect(() => {
    if (!runId || !snapshot || isTerminalStatus(snapshot.run.status)) {
      if (snapshot && isTerminalStatus(snapshot.run.status)) {
        setStreamMode("static");
      }
      return;
    }

    let closed = false;
    let pollTimer: number | undefined;
    let refreshTimer: number | undefined;

    const startPolling = () => {
      if (closed) {
        return;
      }

      setStreamMode("polling");

      pollTimer = window.setInterval(() => {
        void readJson<RunEventPage>(
          `/api/runs/${encodeURIComponent(runId)}/events?after_seq=${cursorRef.current}`
        ).then((page) => {
          if (closed || page.events.length === 0) {
            return;
          }

          cursorRef.current = Math.max(cursorRef.current, ...page.events.map((event) => event.seq));
          setEvents((current) => mergeRunEvents(current, page.events));
          void refreshSnapshot().catch(() => undefined);
        }).catch(() => undefined);
      }, 1200);
    };

    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      startPolling();

      return () => {
        closed = true;

        if (pollTimer !== undefined) {
          window.clearInterval(pollTimer);
        }
      };
    }

    const stream = new EventSource(
      routePath(`/api/runs/${encodeURIComponent(runId)}/events/stream?after_seq=${cursorRef.current}`)
    );
    setStreamMode("live");

    const handleEvent = (message: Event) => {
      const payload = JSON.parse((message as MessageEvent<string>).data) as RunEvent;
      cursorRef.current = Math.max(cursorRef.current, payload.seq);
      setEvents((current) => mergeRunEvents(current, [payload]));

      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }

      refreshTimer = window.setTimeout(() => {
        void refreshSnapshot().catch(() => undefined);
      }, 180);
    };

    for (const eventType of runtimeEventTypes) {
      stream.addEventListener(eventType, handleEvent);
    }

    stream.onerror = () => {
      if (closed) {
        return;
      }

      stream.close();
      startPolling();
    };

    return () => {
      closed = true;
      stream.close();

      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
      }

      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [runId, snapshot]);

  return {
    snapshot,
    events,
    stream_mode: streamMode,
    error,
    refresh: refreshSnapshot
  };
}
