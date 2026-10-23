import { render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import i18n from "@/i18n";
import type { AgentTurn } from "@/lib/agent";
import { AgentUsage } from "./AgentUsage";

const turn: AgentTurn = { id: "one", conversation_id: "chat", user_text: "Hi", assistant_text: "Hello", provider: "anthropic",
  model: "claude", status: "completed", error: null, changes: [], created_at: "2026-10-23T08:00:00Z" };
beforeEach(() => i18n.changeLanguage("en"));

it("shows reported cache hits and separates title/suggestion costs", () => {
  const usage = { requests: 2, reported_requests: 2, models: ["claude"], input_tokens: 50, cache_creation_input_tokens: 100,
    cache_read_input_tokens: 2000, output_tokens: 30, total_input_tokens: 2150 };
  render(<AgentUsage turn={{ ...turn, options: { usage: { chat: usage, title: { ...usage, requests: 1 } } } }} />);
  expect(screen.getByText(/4000 tokens read from cache/)).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Chat and tool loop", hidden: true })).getByText("2,000")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Title generation", hidden: true })).toBeInTheDocument();
});

it("distinguishes missing statistics from an explicitly reported zero", () => {
  const view = render(<AgentUsage turn={{ ...turn, options: { usage: { chat: { requests: 1, reported_requests: 0, models: ["claude"] } } } }} />);
  expect(screen.getByText(/Cache statistics not reported/)).toBeInTheDocument();
  expect(screen.getAllByText("Not reported")).toHaveLength(5);
  view.rerender(<AgentUsage turn={{ ...turn, options: { usage: { chat: { requests: 1, reported_requests: 1, models: ["claude"], cache_read_input_tokens: 0 } } } }} />);
  expect(screen.getByText(/0 tokens read from cache/)).toBeInTheDocument();
});

it("preserves old chats with no usage and omits Claude metrics for other protocols", () => {
  const view = render(<AgentUsage turn={turn} />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<AgentUsage turn={{ ...turn, provider: "openai", options: { usage: { chat: { requests: 1, reported_requests: 0, models: ["gpt"] } } } }} />);
  expect(view.container).toBeEmptyDOMElement();
});
