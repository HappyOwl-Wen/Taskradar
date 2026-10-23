import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { agentApi, AGENT_DEFAULTS, AGENT_OPTION_DEFAULTS, type AgentModel, type AgentStatus, type AgentTurn } from "@/lib/agent";
import { AgentSidebar } from "./AgentSidebar";

const config: AgentStatus = { provider: "anthropic", ...AGENT_DEFAULTS.anthropic, ...AGENT_OPTION_DEFAULTS, workspace_access: true, configured: true, secret_store_available: true };
const selected: AgentModel = { id: config.model, name: config.model, reasoning_levels: ["auto", "low", "high"], reasoning_kind: "effort", capability_source: "api", usable: true, tool_calling: true };
const conversation = { id: "conversation-1", title: "A chat", updated_at: "2026-10-23T10:00:00Z" };
function turn(changes = false): AgentTurn {
  return { id: "turn-1", conversation_id: conversation.id, user_text: "Plan a report", assistant_text: "Please review this proposal.", status: "completed", error: null, created_at: conversation.updated_at, provider: "anthropic", model: config.model,
    changes: changes ? [{ id: "change-1", kind: "create_task", title: "Project report", payload: { title: "Project report", due_date: "2026-10-30" }, before: null, conflicts: null, status: "pending", error: null }] : [] };
}
function view(open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  return render(<AgentSidebar open={open} onOpenChange={vi.fn()} />, { wrapper });
}

describe("AI Agent sidebar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.clear();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.spyOn(agentApi, "config").mockResolvedValue(config);
    vi.spyOn(agentApi, "models").mockResolvedValue({ provider: config.provider, base_url: config.base_url, models: [selected], selected });
    vi.spyOn(agentApi, "preferences").mockImplementation(async (patch) => ({ ...config, ...patch }));
    vi.spyOn(agentApi, "conversations").mockResolvedValue({ items: [conversation] });
    vi.spyOn(agentApi, "history").mockResolvedValue({ items: [], has_more: false });
    vi.spyOn(agentApi, "apply").mockResolvedValue(turn());
    vi.spyOn(agentApi, "discard").mockResolvedValue(turn());
    vi.spyOn(agentApi, "newConversation").mockResolvedValue({ ...conversation, id: "new-conversation" });
    vi.spyOn(agentApi, "chat").mockResolvedValue({ ...turn(), assistant_text: "The Pomodoro technique alternates focus and rest." });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("offers API setup and disables sending until a key is configured", async () => {
    vi.mocked(agentApi.config).mockResolvedValue({ ...config, configured: false });
    view();
    expect(await screen.findByRole("link", { name: "Configure API" })).toHaveAttribute("href", "/settings?section=agent");
    expect(screen.getByLabelText("Message AI Agent")).toBeDisabled();
  });

  it("automatically detects models and persists thinking and execution preferences", async () => {
    view();
    await userEvent.click(await screen.findByRole("button", { name: "Model and thinking settings" }));
    const thinking = await screen.findByRole("combobox", { name: "Thinking level" });
    await waitFor(() => expect(thinking).toHaveTextContent("High"));
    expect(agentApi.models).toHaveBeenCalledWith();
    expect(thinking).not.toHaveTextContent("Very high");
    await userEvent.selectOptions(thinking, "high");
    await waitFor(() => expect(agentApi.preferences).toHaveBeenCalledWith({ reasoning_effort: "high" }));
    await userEvent.click(screen.getByRole("button", { name: "Detect available models again" }));
    await waitFor(() => expect(agentApi.models).toHaveBeenCalledWith(true));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Execution mode" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "YOLO · Apply automatically" }));
    await waitFor(() => expect(agentApi.preferences).toHaveBeenCalledWith({ execution_mode: "yolo" }));
    expect(screen.getByRole("button", { name: "Execution mode" })).toHaveTextContent("YOLO");
  });

  it("keeps controls inside the composer and opens details without submitting the draft", async () => {
    view();
    const input = await screen.findByLabelText("Message AI Agent");
    await waitFor(() => expect(input).toBeEnabled());
    const tools = screen.getByRole("toolbar", { name: "Message tools" });
    expect(tools.closest("form")).toBe(input.closest("form"));
    expect(screen.queryByRole("combobox", { name: "Chat model" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Thinking level" })).not.toBeInTheDocument();
    await userEvent.type(input, "An unfinished question");
    await userEvent.click(within(tools).getByRole("button", { name: "Model and thinking settings" }));
    expect(await screen.findByRole("dialog", { name: "Model and thinking settings" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("combobox", { name: "Chat model" })).not.toBeInTheDocument();
    expect(input).toHaveValue("An unfinished question");
    expect(agentApi.chat).not.toHaveBeenCalled();
  });

  it("retains access to privacy information through the compact footer", async () => {
    view();
    const information = await screen.findByRole("button", { name: "Data and privacy information" });
    expect(screen.queryByText(/Messages, conversation context and relevant task/)).not.toBeInTheDocument();
    await userEvent.click(information);
    expect(await screen.findByRole("dialog", { name: "Data and privacy information" })).toHaveTextContent("Chat history stays on this device");
  });

  it("fills follow-up suggestions without sending them and allows turning suggestions off", async () => {
    vi.mocked(agentApi.history).mockResolvedValue({ items: [turn()], has_more: false });
    view();
    const suggestion = await screen.findByRole("button", { name: /Use suggestion: Explain the previous point/ });
    await userEvent.click(suggestion);
    expect(screen.getByLabelText("Message AI Agent")).toHaveValue("Explain the previous point with a concrete example");
    expect(agentApi.chat).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Prompt suggestion options" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Off" }));
    await waitFor(() => expect(agentApi.preferences).toHaveBeenCalledWith({ prompt_suggestions: "off" }));
    expect(screen.queryByRole("region", { name: "Continue the conversation" })).not.toBeInTheDocument();
  });

  it("generates a title from the chat actions menu", async () => {
    vi.mocked(agentApi.history).mockResolvedValue({ items: [turn()], has_more: false });
    vi.spyOn(agentApi, "generateTitle").mockResolvedValue({ id: conversation.id, title: "Generated plan" });
    view();
    await screen.findByText("Please review this proposal.");
    await userEvent.click(screen.getByRole("button", { name: "Chat title and actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Generate title with a model" }));
    await waitFor(() => expect(agentApi.generateTitle).toHaveBeenCalledExactlyOnceWith(conversation.id));
  });

  it("supports ordinary chat without proposing or applying changes", async () => {
    view();
    const input = await screen.findByLabelText("Message AI Agent");
    await waitFor(() => expect(input).toBeEnabled());
    await userEvent.type(input, "Explain Pomodoro{Enter}");
    expect(await screen.findByText("The Pomodoro technique alternates focus and rest.")).toBeInTheDocument();
    expect(agentApi.chat).toHaveBeenCalledWith(conversation.id, "Explain Pomodoro", expect.any(String));
    expect(agentApi.apply).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Apply changes" })).not.toBeInTheDocument();
  });

  it("previews concrete changes and applies only on the explicit button", async () => {
    let state = turn(true);
    vi.mocked(agentApi.history).mockImplementation(async () => ({ items: [state], has_more: false }));
    vi.mocked(agentApi.apply).mockImplementation(async () => {
      state = { ...state, changes: state.changes.map((change) => ({ ...change, status: "applied" as const, result: { task_id: "task-1" } })) };
      return state;
    });
    view();
    expect(await screen.findByText("2026-10-30")).toBeInTheDocument();
    expect(agentApi.apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByRole("link", { name: "View task" })).toHaveAttribute("href", "/tasks/task-1");
    expect(agentApi.apply).toHaveBeenCalledExactlyOnceWith("turn-1");
    expect(screen.queryByRole("button", { name: "Apply changes" })).not.toBeInTheDocument();
  });

  it("discards unapplied proposals without executing them", async () => {
    let state = turn(true);
    vi.mocked(agentApi.history).mockImplementation(async () => ({ items: [state], has_more: false }));
    vi.mocked(agentApi.discard).mockImplementation(async () => {
      state = { ...state, changes: state.changes.map((change) => ({ ...change, status: "skipped" as const })) };
      return state;
    });
    view();
    await userEvent.click(await screen.findByRole("button", { name: "Discard unapplied changes" }));
    await waitFor(() => expect(agentApi.discard).toHaveBeenCalledExactlyOnceWith("turn-1"));
    expect(agentApi.apply).not.toHaveBeenCalled();
  });

  it("does not send Enter while composing Chinese and supports Shift+Enter", async () => {
    view();
    const input = await screen.findByLabelText("Message AI Agent");
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "安排任务" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(agentApi.chat).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(agentApi.chat).toHaveBeenCalledOnce());
  });

  it("preserves a draft when the panel closes and creates a new chat lazily", async () => {
    const rendered = view();
    const input = await screen.findByLabelText("Message AI Agent");
    await waitFor(() => expect(input).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await userEvent.type(input, "Draft question");
    rendered.rerender(<AgentSidebar open={false} onOpenChange={vi.fn()} />);
    rendered.rerender(<AgentSidebar open onOpenChange={vi.fn()} />);
    expect(await screen.findByLabelText("Message AI Agent")).toHaveValue("Draft question");
    expect(agentApi.newConversation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(agentApi.chat).toHaveBeenCalledWith("new-conversation", "Draft question", expect.any(String)));
  });

  it("shows provider failures as a recoverable chat message", async () => {
    vi.mocked(agentApi.history).mockResolvedValue({ items: [{ ...turn(), assistant_text: "", status: "failed", error: "agent_auth_failed" }], has_more: false });
    view();
    expect(await screen.findByRole("alert")).toHaveTextContent("API authentication failed");
    await userEvent.click(screen.getByRole("button", { name: "Resend this message" }));
    expect(screen.getByLabelText("Message AI Agent")).toHaveValue("Plan a report");
  });
});
