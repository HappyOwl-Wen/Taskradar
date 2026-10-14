import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { refreshAll, useSources } from "@/lib/queries";

/**
 * Refreshes everything on screen whenever a sync job starts or finishes, including scheduled
 * background syncs, so new tasks appear without a manual reload.
 */
export function SyncWatcher() {
  const queryClient = useQueryClient();
  const { data } = useSources();
  const signature = data?.items.map((s) => `${s.id}:${s.last_job?.id ?? 0}:${s.last_job?.status ?? ""}:${s.status}`).join("|");
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (signature === undefined) return;
    if (previous.current !== undefined && previous.current !== signature) void refreshAll(queryClient);
    previous.current = signature;
  }, [signature, queryClient]);
  return null;
}
