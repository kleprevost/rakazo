import type { ThreadSnapshot } from "@rakazo/contracts";
import { isRunTerminalEvent, runThreadSubscription } from "@rakazo/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import {
  isThreadSnapshotEvent,
  prependThreadMessagePage,
  reconcileRefreshedThread,
  reduceThreadSnapshot,
} from "../../lib/thread-events";

/**
 * An assignment's conversation: the same snapshot, live events and older pages a chat has,
 * addressed by the assignment instead of a bot or a group.
 */
export function useAssignmentThread(assignmentId: string) {
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const terminalRunReceipts = useRef(new Set<string>());
  const refreshEpoch = useRef(0);

  const commit = useCallback((next: ThreadSnapshot | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  const updateSnapshot = useCallback(
    (update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) =>
      commit(update(snapshotRef.current)),
    [commit],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++refreshEpoch.current;
      const snap = await rpc.threads.get({ assignmentId }, signal ? { signal } : undefined);
      if (request === refreshEpoch.current) {
        commit(reconcileRefreshedThread(snapshotRef.current, snap, null).snapshot);
      }
      return snap;
    },
    [assignmentId, commit],
  );

  useEffect(() => {
    const abort = new AbortController();
    // The assignment's own phase, runs and files follow the thread's runs.
    const refreshWork = () => {
      void queryClient.invalidateQueries({ queryKey: queries.assignments.get.key() });
      void queryClient.invalidateQueries({ queryKey: queries.assignments.list.key() });
    };
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: async () => {
        try {
          const snap = await refresh(abort.signal);
          setLoadError(null);
          return snap;
        } catch (error) {
          setLoadError(error);
          throw error;
        }
      },
      loadHead: () => rpc.threads.head({ assignmentId }, { signal: abort.signal }),
      refresh: () => refresh(abort.signal),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor, signal) => rpc.threads.subscribe({ assignmentId, cursor }, { signal }),
      beforeEvent: (event) => {
        if (isRunTerminalEvent(event) && event.runId) terminalRunReceipts.current.add(event.runId);
      },
      applyEvent: (event) => {
        if (isThreadSnapshotEvent(event)) commit(reduceThreadSnapshot(snapshotRef.current, event));
      },
      onEvent: (event) => {
        if (
          event.type === "run.started" ||
          event.type === "run.waiting_input" ||
          isRunTerminalEvent(event)
        ) {
          refreshWork();
        }
        if (isRunTerminalEvent(event) || event.type === "run.waiting_input") {
          void refresh(abort.signal).catch(() => undefined);
        }
      },
    });
    return () => abort.abort();
  }, [assignmentId, commit, queries, queryClient, refresh]);

  const loadOlder = useCallback(async () => {
    const before = snapshotRef.current?.olderCursor;
    if (before == null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await rpc.threads.messages({ assignmentId, before });
      updateSnapshot((prev) => prependThreadMessagePage(prev, page));
    } finally {
      setLoadingOlder(false);
    }
  }, [assignmentId, loadingOlder, updateSnapshot]);

  return {
    snapshot,
    updateSnapshot,
    refresh,
    loadOlder,
    loadingOlder,
    loadError,
    scrollRef,
    terminalRunReceipts,
  };
}
