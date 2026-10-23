import { useQuery } from "@tanstack/react-query";
import { request } from "./api";

export type AgentProvider = "anthropic" | "openai" | "openai_compatible";
export type ReasoningEffort = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ExecutionMode = "restricted" | "yolo";
export const AGENT_OPTION_DEFAULTS = {
  reasoning_effort: "auto" as ReasoningEffort,
  execution_mode: "restricted" as ExecutionMode,
  title_mode: "message" as "message" | "model",
  title_model: null as string | null,
  prompt_suggestions: "presets" as "off" | "presets" | "model",
  prompt_cache: "5m" as "off" | "5m" | "1h",
};
export interface AgentConfig {
  provider: AgentProvider;
  base_url: string;
  model: string;
  workspace_access: boolean;
  reasoning_effort: ReasoningEffort;
  execution_mode: ExecutionMode;
  title_mode: "message" | "model";
  title_model: string | null;
  prompt_suggestions: "off" | "presets" | "model";
  prompt_cache: "off" | "5m" | "1h";
}
export interface AgentStatus extends AgentConfig {
  configured: boolean;
  secret_store_available: boolean;
  model_info?: AgentModel;
}
export interface AgentModel {
  id: string; name: string; reasoning_levels: ReasoningEffort[]; reasoning_kind: "effort" | "budget" | "unknown" | "none";
  capability_source: "api" | "documented" | "unknown"; tool_calling: boolean | null; usable: boolean;
}
export interface AgentModels { provider: AgentProvider; base_url: string; models: AgentModel[]; selected: AgentModel }
export interface AgentConversation { id: string; title: string; updated_at: string; title_source?: string; title_error?: string | null }
export interface AgentChange {
  id: string;
  kind: "create_task" | "update_task" | "delete_task" | "save_work_block" | "delete_work_block" | "save_calendar_event";
  title: string;
  payload: Record<string, unknown>;
  before: Record<string, unknown> | null;
  conflicts: { conflicts: { id: string; title: string; start: string; end: string }[]; unchecked: unknown[]; suggestion: { start: string; end: string } | null } | null;
  status: "pending" | "applied" | "error" | "skipped";
  error: string | null;
  result?: { task_id?: string; work_block_id?: string; calendar_outdated?: boolean };
}
export interface AgentTurn {
  id: string;
  conversation_id: string;
  user_text: string;
  assistant_text: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  changes: AgentChange[];
  provider: AgentProvider;
  model: string;
  created_at: string;
  options?: {
    execution_mode?: ExecutionMode; reasoning_effort?: ReasoningEffort;
    phase?: "thinking" | "applying" | "finishing" | "complete" | "interrupted";
    suggestions?: string[]; suggestions_error?: string; title_error?: string;
    usage?: Partial<Record<"chat" | "title" | "suggestions", AgentUsage>>;
  };
}
export interface AgentUsage {
  requests: number; reported_requests: number; models: string[];
  input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
  output_tokens?: number; total_input_tokens?: number;
}
export interface AgentHistory { items: AgentTurn[]; has_more: boolean }

export const AGENT_DEFAULTS: Record<AgentProvider, { base_url: string; model: string }> = {
  anthropic: { base_url: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5" },
  openai: { base_url: "https://api.openai.com/v1", model: "gpt-5.4-mini" },
  openai_compatible: { base_url: "https://api.openai.com/v1", model: "gpt-5.4-mini" },
};
export const agentKeys = {
  config: ["agent-config"] as const,
  conversations: ["agent-conversations"] as const,
  history: (id: string | null) => ["agent-history", id] as const,
  models: (config?: AgentConfig) => ["agent-models", config?.provider, config?.base_url, config?.model] as const,
};
export const agentApi = {
  config: () => request<AgentStatus>("GET", "/api/agent/config"),
  configure: (config: AgentConfig & { api_key?: string }) => request<AgentStatus>("PUT", "/api/agent/config", { body: config }),
  preferences: (values: Partial<Pick<AgentConfig, "model" | "reasoning_effort" | "execution_mode" | "prompt_suggestions">>) => request<AgentStatus>("PATCH", "/api/agent/config", { body: values }),
  models: (refresh = false) => request<AgentModels>("GET", "/api/agent/models", { query: { refresh } }),
  forgetKey: () => request<AgentStatus>("DELETE", "/api/agent/key"),
  conversations: () => request<{ items: AgentConversation[] }>("GET", "/api/agent/conversations"),
  newConversation: () => request<AgentConversation>("POST", "/api/agent/conversations"),
  history: (id: string) => request<AgentHistory>("GET", `/api/agent/conversations/${id}`),
  deleteConversation: (id: string) => request<{ deleted: boolean }>("DELETE", `/api/agent/conversations/${id}`),
  chat: (id: string, text: string, requestId: string) => request<AgentTurn>("POST", `/api/agent/conversations/${id}/messages`, { body: { text, request_id: requestId } }),
  apply: (id: string) => request<AgentTurn>("POST", `/api/agent/turns/${id}/apply`, { body: { confirm: true } }),
  discard: (id: string) => request<AgentTurn>("POST", `/api/agent/turns/${id}/discard`),
  rename: (id: string, title: string) => request<Pick<AgentConversation, "id" | "title" | "title_source" | "title_error">>("PATCH", `/api/agent/conversations/${id}`, { body: { title } }),
  generateTitle: (id: string) => request<Pick<AgentConversation, "id" | "title" | "title_source" | "title_error">>("POST", `/api/agent/conversations/${id}/title`, { body: {} }),
  suggestions: (id: string) => request<{ items: string[] }>("POST", `/api/agent/conversations/${id}/suggestions`),
};
export const useAgentConfig = (enabled = true) => useQuery({ queryKey: agentKeys.config, queryFn: agentApi.config, enabled, staleTime: 30_000 });
export const useAgentModels = (config?: AgentStatus, enabled = true) => useQuery({
  queryKey: agentKeys.models(config), queryFn: () => agentApi.models(), enabled: enabled && Boolean(config?.configured), staleTime: 300_000, retry: false, refetchOnWindowFocus: false,
});

export function modelCapability(config: AgentStatus, catalog?: AgentModels): AgentModel | undefined {
  return catalog?.models.find((model) => model.id === config.model) ?? (catalog?.selected.id === config.model ? catalog.selected : config.model_info?.id === config.model ? config.model_info : undefined);
}
