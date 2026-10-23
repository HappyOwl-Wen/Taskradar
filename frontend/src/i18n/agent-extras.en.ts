import type zh from "./agent-extras.zh";
type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
const extras: Strings<typeof zh> = {
  cache: {
    setting: "Claude prompt cache", off: "Off", "5m": "5 minutes (default)", "1h": "1 hour",
    settingHint: "Reuse fixed prompt and history prefixes. Cache writes are billed; 1-hour writes cost more. The service must support Anthropic cache_control. Turn off for unsupported gateways.",
    usage: "Usage and cache", calls: "{{count}} call attempts", readSummary: "{{count}} tokens read from cache",
    unavailable: "Cache statistics not reported", unknown: "Not reported", input_tokens: "Uncached input", cache_creation_input_tokens: "Cache writes",
    cache_read_input_tokens: "Cache reads", output_tokens: "Output", total_input_tokens: "Total input",
    chat: "Chat and tool loop", title: "Title generation", suggestions: "Prompt suggestions",
    reported: "Usage reported for {{reported}} / {{count}} attempts", reportedHint: "Counters come from the service; missing values are not zero. First calls, expiry, short prefixes or unsupported gateways may miss. Your provider determines the actual bill.",
  },
  resize: "Resize Agent sidebar", resizeHint: "Drag to resize; use arrow keys for fine adjustments; double-click to reset",
  controls: {
    modelSettings: "Model and thinking settings", composerTools: "Message tools", privacyInfo: "Data and privacy information",
    autoShort: "Auto", restrictedShort: "Review", yoloShort: "YOLO", chatShort: "Chat only",
    model: "Chat model", reasoning: "Thinking level", mode: "Execution mode", refresh: "Detect available models again",
    scanning: "Checking models on this service…", modelCount: "{{count}} models detected", api: "Capabilities reported by the API", documented: "Capabilities from known model documentation", unknown: "Thinking capabilities not reported; using provider defaults",
    restricted: "Restricted · Review first", yolo: "YOLO · Apply automatically", yoloHint: "Task and event changes from new messages are applied automatically. Calendar permissions, validation and conflict checks still apply.",
    nextMessage: "Model, thinking and mode changes take effect on your next message.", auto: "Auto / provider default", none: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Very high", max: "Maximum", unsupported: "Not supported by this model", thinkingBudget: "This model maps thinking levels to token budgets", phaseApplying: "Applying changes automatically…", phaseFinishing: "Generating title and suggestions…",
  },
  preferences: {
    reasoningHint: "Only levels known to be supported by the current model and protocol are offered. Higher levels usually take more time and tokens. Auto sends no extra thinking parameters.",
    modeHint: "Restricted mode previews changes for manual application. YOLO applies proposals from new messages automatically; it does not execute older pending proposals.",
    modelListHint: "Models are detected from your saved service. Refresh manually or enter an unlisted model ID. Being listed does not guarantee tool-calling support.", saveBeforeScan: "Save the service URL and key before detecting models for this configuration.",
    titleMode: "Automatic chat titles", titleMessage: "Use the first message", titleModelMode: "Generate with a model", titleModel: "Title generation model", titleModelHint: "Leave blank to use the chat model. Choose a detected model or enter another ID.", titleCost: "Model titles are generated after the first successful reply; model suggestions after each successful reply. Both make additional API calls using conversation context.", suggestions: "Prompt suggestions", suggestionsOff: "Off", suggestionsPresets: "Presets", suggestionsModel: "Generate follow-up prompts",
  },
  titles: { menu: "Chat title and actions", rename: "Rename chat", generate: "Generate title with a model", title: "Chat title", save: "Save title", generated: "Title generated", renamed: "Title updated", failed: "Title generation failed. The existing title is retained; you can retry later.", using: "Title model: {{model}}" },
  prompts: { options: "Prompt suggestion options", label: "Continue the conversation", generate: "Regenerate suggestions", applySuggestion: "Use suggestion: {{text}}", plan: "Review the coming days and find the tasks that need attention first", summary: "Summarize the current plan and any changes that have not been applied", chat: "Explain the previous point with a concrete example", failed: "Could not generate follow-up prompts. Your reply and applied changes are retained." },
};
export default extras;
