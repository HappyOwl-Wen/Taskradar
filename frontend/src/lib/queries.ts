import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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

/** Sources poll quickly while a sync is running so progress shows up without a manual refresh. */
export const useSources = () =>
  useQuery({
    queryKey: qk.sources,
    queryFn: api.sources,
    refetchInterval: (query) => (query.state.data?.items.some((s) => s.running) ? 1500 : 20_000),
  });

export const useDocuments = () => useQuery({ queryKey: qk.documents, queryFn: api.documents });
export const useMessages = () => useQuery({ queryKey: qk.messages, queryFn: api.messages });
export const useJobs = () => useQuery({ queryKey: qk.jobs, queryFn: () => api.jobs(40) });
export const useFailures = () => useQuery({ queryKey: qk.failures, queryFn: api.failures });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
export const useSystemStatus = () => useQuery({ queryKey: qk.system, queryFn: api.systemStatus, staleTime: 15_000 });
export const useGoogle = () => useQuery({ queryKey: qk.google, queryFn: api.google });
export const useNotifications = () =>
  useQuery({ queryKey: qk.notifications, queryFn: api.notifications, refetchInterval: 30_000 });
export const useMetrics = () => useQuery({ queryKey: qk.metrics, queryFn: api.metrics });
export const useAgentRuns = () => useQuery({ queryKey: qk.agentRuns, queryFn: () => api.agentRuns(60) });

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
      options.onSuccess?.(data);
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
    onSettled: () => {
      if (options.invalidate !== false) void queryClient.invalidateQueries();
    },
  });
}
