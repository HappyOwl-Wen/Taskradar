import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { AGENT_DEFAULTS, AGENT_OPTION_DEFAULTS, agentApi, type AgentModel } from "@/lib/agent";
import { DirtyReporter } from "@/lib/settings";
import { AgentSection } from "./Agent";

const saved = { provider: "anthropic" as const, ...AGENT_DEFAULTS.anthropic, ...AGENT_OPTION_DEFAULTS, workspace_access: true, configured: true, secret_store_available: true };
const selected: AgentModel = { id: saved.model, name: saved.model, reasoning_levels: ["auto", "low", "high"], reasoning_kind: "effort", capability_source: "api", usable: true, tool_calling: true };
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(agentApi, "config").mockResolvedValue(saved);
  vi.spyOn(agentApi, "configure").mockResolvedValue(saved);
  vi.spyOn(agentApi, "models").mockResolvedValue({ provider: saved.provider, base_url: saved.base_url, models: [selected], selected });
});
afterEach(() => vi.restoreAllMocks());

function view() {
  const dirty = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DirtyReporter.Provider value={dirty}><AgentSection /></DirtyReporter.Provider>
  </QueryClientProvider>);
  return dirty;
}

it("retains an existing key on blank input and reports unsaved edits", async () => {
  const dirty = view();
  const model = await screen.findByLabelText("Model ID");
  expect(screen.getByLabelText("API key")).toHaveValue("");
  await userEvent.clear(model);
  await userEvent.type(model, "custom-model");
  expect(dirty).toHaveBeenCalledWith("agent", true);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(agentApi.configure).toHaveBeenCalledExactlyOnceWith({ provider: "anthropic", base_url: saved.base_url, model: "custom-model", ...AGENT_OPTION_DEFAULTS, workspace_access: true }));
});

it("clears the password field after saving a replacement key", async () => {
  view();
  const key = await screen.findByLabelText("API key");
  expect(key).toHaveAttribute("type", "password");
  await userEvent.type(key, "test-replacement-key");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(agentApi.configure).toHaveBeenCalledWith(expect.objectContaining({ api_key: "test-replacement-key" })));
  await waitFor(() => expect(key).toHaveValue(""));
});

it("saves a separate title model and detects models for the saved service", async () => {
  view();
  const titleModel = await screen.findByLabelText("Title generation model");
  expect(await screen.findByText("1 models detected")).toBeInTheDocument();
  await userEvent.type(titleModel, "small-title-model");
  await userEvent.selectOptions(screen.getByLabelText("Thinking level"), "high");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(agentApi.configure).toHaveBeenCalledWith(expect.objectContaining({ title_model: "small-title-model", reasoning_effort: "high" })));
});
