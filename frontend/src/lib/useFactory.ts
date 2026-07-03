"use client";

// The one seam between the FastAPI backend and React: open a WebSocket, store
// the latest Snapshot, and expose the three commands. Auto-reconnects so the
// page survives a backend restart.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, Snapshot } from "./types";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/factory";

export function useFactory() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => setSnap(JSON.parse(e.data) as Snapshot);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((cmd: Command) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
  }, []);

  return {
    snap,
    connected,
    start: useCallback(() => send({ type: "start" }), [send]),
    stop: useCallback(() => send({ type: "stop" }), [send]),
    setSpeed: useCallback((value: number) => send({ type: "setSpeed", value }), [send]),
    chat: useCallback(
      (text: string, files: { name: string; content: string }[]) =>
        send({ type: "chat", text, files }),
      [send],
    ),
    reset: useCallback(() => send({ type: "reset" }), [send]),
    setEvals: useCallback(
      (evals: { id?: string; criterion: string; kind?: "llm" | "command"; command?: string; target?: number }[]) =>
        send({ type: "setEvals", evals }),
      [send],
    ),
    setMaxLoops: useCallback(
      (value: number, enabled: boolean) => send({ type: "setMaxLoops", value, enabled }),
      [send],
    ),
    setTargetAccuracy: useCallback(
      (value: number) => send({ type: "setTargetAccuracy", value }),
      [send],
    ),
    setGoal: useCallback((text: string) => send({ type: "setGoal", text }), [send]),
    setPerCriterionTargets: useCallback((enabled: boolean) => send({ type: "setPerCriterionTargets", enabled }), [send]),
    setCriterionTargets: useCallback((targets: Record<string, number>) => send({ type: "setCriterionTargets", targets }), [send]),
    setAgents: useCallback(
      (agents: { id?: string; name: string; kind: string; role: string; model: string }[]) =>
        send({ type: "setAgents", agents }),
      [send],
    ),
    resolveGate: useCallback((approve: boolean) => send({ type: "resolveGate", approve }), [send]),
    setLocked: useCallback((value: boolean) => send({ type: "setLocked", value }), [send]),
  };
}
