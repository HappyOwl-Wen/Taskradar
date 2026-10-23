import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "@/i18n";
import { api, type TaskQuery } from "./api";
import { errorMessage } from "./errors";

export const qk = {
  dashboard: ["dashboard"] as const,
  tasks: (query: TaskQuery) => ["tasks", query] as const,
  task: (id: string) => ["task", id] as const,
  settings: ["settings"] as const,
  system: ["system"] as const,
  systemSummary: ["system-summary"] as const,
  google: ["google"] as const,
  notifications: ["notifications"] as const,
  legacy: ["legacy"] as const,
  timers: ["timers"] as const,
  timerAlarm: ["timer-alarm"] as const,
};

export const useDashboard = () => useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard, refetchInterval: 30_000 });

export const useTasks = (query: TaskQuery) =>
  useQuery({ queryKey: qk.tasks(query), queryFn: () => api.tasks(query), placeholderData: keepPreviousData });

export const useTask = (id: string | undefined) =>
  useQuery({ queryKey: qk.task(id ?? ""), queryFn: () => api.task(id ?? ""), enabled: Boolean(id) });

/** Refetch everything on screen except the session (CSRF token) query. */
export function refreshAll(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "session" });
}

/** Refetch the tasks on screen: the board, the lists and a task's page. */
export function refreshTasks(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (query) => ["dashboard", "tasks", "task"].includes(String(query.queryKey[0])) });
}

export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
export const useSystemStatus = () => useQuery({ queryKey: qk.system, queryFn: api.systemStatus, staleTime: 15_000 });
/** Runtime problems in plain terms; it changes slowly, so a minute between checks is enough. */
export const useSystemSummary = () =>
  useQuery({ queryKey: qk.systemSummary, queryFn: api.systemSummary, refetchInterval: 60_000, retry: false });
export const useGoogle = () => useQuery({ queryKey: qk.google, queryFn: api.google });
export const useNotifications = () =>
  useQuery({ queryKey: qk.notifications, queryFn: api.notifications, refetchInterval: 30_000 });
/** What earlier versions left behind (imported mails and files, old sign-ins): shown only while it exists. */
export const useLegacyData = () => useQuery({ queryKey: qk.legacy, queryFn: api.legacyData });

/** Dismissing or deleting a task also removes its calendar event; say so when that failed. */
function calendarWarning(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { calendar_warning?: string; calendar_not_removed?: unknown[]; deleted?: unknown };
  if (d.calendar_warning !== "event_not_removed" && !d.calendar_not_removed?.length) return null;
  return i18n.t(d.deleted ? "calendar.notRemovedDeleted" : "calendar.notRemoved");
}

/** Revert recorded changes (newest first) and refresh; failures are shown, never swallowed. */
export async function undoEvents(queryClient: QueryClient, eventIds: number[]): Promise<void> {
  try {
    for (const id of [...eventIds].reverse()) await api.undo(id);
    toast.success(i18n.t("common.undone"));
  } catch (error) {
    toast.error(errorMessage(error));
  } finally {
    void refreshAll(queryClient);
  }
}

interface ActionOptions<TData> {
  /** Toast shown on success; a function receives the response. */
  success?: string | ((data: TData) => string | null);
  /**
   * Events that undo the change; when given, the success toast offers "Undo". Most responses carry
   * `undo_event_id` (single change) or `undo_event_ids` (batch).
   */
  undo?: (data: TData) => (number | null | undefined)[] | number | null | undefined;
  onSuccess?: (data: TData) => void;
  /** Refetch everything that is on screen afterwards (default true). */
  invalidate?: boolean;
}

/**
 * Mutation wrapper used by every button that changes state: errors always surface as a localised
 * toast (never silently swallowed) and the visible data is refreshed afterwards.
 */
export function useAction<TVars, TData>(fn: (vars: TVars) => Promise<TData>, options: ActionOptions<TData> = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      const message = typeof options.success === "function" ? options.success(data) : options.success;
      const undoIds = options.undo ? [options.undo(data)].flat().filter((id): id is number => typeof id === "number") : [];
      if (message && undoIds.length) {
        toast.success(message, {
          duration: 10_000,
          action: { label: i18n.t("common.undo"), onClick: () => void undoEvents(queryClient, undoIds) },
        });
      } else if (message) {
        toast.success(message);
      }
      const warning = calendarWarning(data);
      if (warning) toast.warning(warning, { duration: 10_000 });
      options.onSuccess?.(data);
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
    onSettled: () => {
      if (options.invalidate !== false) void refreshAll(queryClient);
    },
  });
}
