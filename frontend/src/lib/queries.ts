import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "@/i18n";
import { api, type TaskQuery } from "./api";
import { errorMessage } from "./errors";

export const qk = {
  dashboard: ["dashboard"] as const,
  tasks: (query: TaskQuery) => ["tasks", query] as const,
  task: (id: string) => ["task", id] as const,
  suggestions: ["suggestions"] as const,
  sources: ["sources"] as const,
  documents: ["documents"] as const,
  messages: ["messages"] as const,
  jobs: ["jobs"] as const,
  failures: ["failures"] as const,
  settings: ["settings"] as const,
  system: ["system"] as const,
  google: ["google"] as const,
  notifications: ["notifications"] as const,
  metrics: ["metrics"] as const,
  agentRuns: ["agent-runs"] as const,
};

export const useDashboard = () => useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard, refetchInterval: 30_000 });

export const useTasks = (query: TaskQuery) =>
  useQuery({ queryKey: qk.tasks(query), queryFn: () => api.tasks(query), placeholderData: keepPreviousData });

export const useTask = (id: string | undefined) =>
  useQuery({ queryKey: qk.task(id ?? ""), queryFn: () => api.task(id ?? ""), enabled: Boolean(id) });

export const useSuggestions = () => useQuery({ queryKey: qk.suggestions, queryFn: api.suggestions });

/** Refetch everything on screen except the session (CSRF token) query. */
export function refreshAll(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "session" });
}

let fastPollUntil = 0;

/** Sync jobs start asynchronously after the request returns, so poll quickly for a while. */
export function expectSourceActivity(ms = 15_000): void {
  fastPollUntil = Date.now() + ms;
}

/** Sources poll quickly while a sync is running so progress shows up without a manual refresh. */
export const useSources = () =>
  useQuery({
    queryKey: qk.sources,
    queryFn: api.sources,
    refetchInterval: (query) => (Date.now() < fastPollUntil || query.state.data?.items.some((s) => s.running) ? 1500 : 20_000),
  });

export const useDocuments = () => useQuery({ queryKey: qk.documents, queryFn: api.documents });
export const useMessages = () => useQuery({ queryKey: qk.messages, queryFn: api.messages });
export const useJobs = () => useQuery({ queryKey: qk.jobs, queryFn: () => api.jobs(40) });
export const useFailures = () => useQuery({ queryKey: qk.failures, queryFn: api.failures });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
export const useSystemStatus = () =>
  useQuery({
    queryKey: qk.system,
    queryFn: api.systemStatus,
    staleTime: 15_000,
    // While files are being read again with OCR, poll so the page updates when the job finishes.
    refetchInterval: (query) => (query.state.data?.ocr.reprocessing ? 2000 : false),
  });
export const useGoogle = () => useQuery({ queryKey: qk.google, queryFn: api.google });
export const useNotifications = () =>
  useQuery({ queryKey: qk.notifications, queryFn: api.notifications, refetchInterval: 30_000 });
export const useMetrics = () => useQuery({ queryKey: qk.metrics, queryFn: api.metrics });
export const useAgentRuns = () => useQuery({ queryKey: qk.agentRuns, queryFn: () => api.agentRuns(60) });

/** Dismissing, merging or deleting a task also removes its calendar event; say so when that failed. */
function calendarWarning(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { calendar_warning?: string; calendar_not_removed?: unknown[]; deleted?: unknown };
  if (d.calendar_warning !== "event_not_removed" && !d.calendar_not_removed?.length) return null;
  return i18n.t(d.deleted ? "calendar.notRemovedDeleted" : "calendar.notRemoved");
}

interface ActionOptions<TData> {
  /** Toast shown on success; a function receives the response. */
  success?: string | ((data: TData) => string | null);
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
      if (message) toast.success(message);
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
