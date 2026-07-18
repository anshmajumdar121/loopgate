// Curated catalog of provider presets the Connections UI offers. When the
// user picks a preset, the endpoint / model dropdown / api-key hint all
// pre-fill with sensible defaults — they can still override any of them.
//
// Adding a preset here is the right way to onboard a new provider.
// Existing connections store the resolved values (baseUrl, providerType,
// model) so they survive catalog changes.

import type { ConnectionProviderId, ConnectionProviderType } from "@/types/loop";

export interface ProviderModel {
  /** Upstream model id as the provider knows it (e.g. "gpt-4o-mini",
   *  "anthropic/claude-3.5-sonnet"). */
  id: string;
  /** Friendly name shown in the picker dropdown. */
  label: string;
}

export interface ProviderPreset {
  id: ConnectionProviderId;
  /** Friendly name shown in the provider dropdown. */
  name: string;
  /** Marketing blurb / hint shown directly under the provider dropdown. */
  description: string;
  /** Underlying SDK category — drives which npm package opencode uses
   *  to route requests to this endpoint. */
  providerType: ConnectionProviderType;
  /** Default base URL, prefilled in the endpoint field on selection. */
  defaultBaseUrl: string;
  /** Placeholder shown in the endpoint input. */
  endpointHint: string;
  /** Placeholder shown in the api key field (e.g. "sk-or-…"). */
  apiKeyHint: string;
  /** True if this provider doesn't need an API key (e.g. local Ollama).
   *  The UI hides the key field when set. */
  noKey?: boolean;
  /** Default temperature for new connections to this provider. */
  temperatureDefault: number;
  /** Curated quick-pick models shown in the model dropdown. Users can
   *  pick one or type their own via the "Custom..." option. Empty list
   *  means the model field is a free-text input directly. */
  models: ProviderModel[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    description:
      "Get a free key at openrouter.ai — access 200+ models with one key.",
    providerType: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    endpointHint: "https://openrouter.ai/api/v1",
    apiKeyHint: "sk-or-…",
    temperatureDefault: 0.7,
    models: [
      { id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
      { id: "openai/gpt-4o", label: "GPT-4o" },
      { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
      { id: "meta-llama/llama-3.1-70b-instruct", label: "Llama 3.1 70B" },
      { id: "google/gemini-2.0-flash-exp", label: "Gemini 2.0 Flash" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "Direct OpenAI API access.",
    providerType: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    endpointHint: "https://api.openai.com/v1",
    apiKeyHint: "sk-…",
    temperatureDefault: 0.7,
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "o1-mini", label: "o1-mini" },
      { id: "o1-preview", label: "o1-preview" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Direct Anthropic API access.",
    providerType: "anthropic-compatible",
    defaultBaseUrl: "https://api.anthropic.com",
    endpointHint: "https://api.anthropic.com",
    apiKeyHint: "sk-ant-…",
    temperatureDefault: 0.7,
    models: [
      { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
      { id: "claude-3-opus-latest", label: "Claude 3 Opus" },
    ],
  },
  {
    id: "google",
    name: "Google AI",
    description: "Gemini models via the Google Generative AI endpoint.",
    providerType: "openai-compatible",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    endpointHint: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyHint: "AIza…",
    temperatureDefault: 0.7,
    models: [
      { id: "gemini-2.0-flash-exp", label: "Gemini 2.0 Flash" },
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    description: "Run models locally — no key needed.",
    providerType: "openai-compatible",
    defaultBaseUrl: "http://localhost:11434/v1",
    endpointHint: "http://localhost:11434/v1",
    apiKeyHint: "(leave blank for local models)",
    noKey: true,
    temperatureDefault: 0.7,
    models: [
      { id: "llama3.1:8b", label: "Llama 3.1 8B" },
      { id: "llama3.1:70b", label: "Llama 3.1 70B" },
      { id: "qwen2.5:7b", label: "Qwen 2.5 7B" },
      { id: "mistral-large:latest", label: "Mistral Large" },
    ],
  },
  {
    id: "local-cli",
    name: "Local CLI (no API key)",
    description:
      "Runs the loop through your machine's `claude` CLI — no API key, no network endpoint. Uses your existing Claude Code subscription.",
    providerType: "local-cli",
    defaultBaseUrl: "http://localhost/local-cli",
    endpointHint: "(not used in CLI mode)",
    apiKeyHint: "(not needed)",
    noKey: true,
    temperatureDefault: 0.7,
    models: [],
  },
  {
    id: "custom",
    name: "Custom (BYO endpoint)",
    description:
      "Anything OpenAI-compatible or Anthropic-compatible — paste your endpoint and key.",
    providerType: "openai-compatible",
    defaultBaseUrl: "",
    endpointHint: "https://your-api.example.com/v1",
    apiKeyHint: "API key (optional)",
    temperatureDefault: 0.7,
    models: [],
  },
];

/** Look up a preset by id. Returns the "custom" preset as a safe fallback. */
export function presetFor(id: ConnectionProviderId | undefined): ProviderPreset {
  if (!id) return PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]; // custom
  return (
    PROVIDER_PRESETS.find((p) => p.id === id) ??
    PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
  );
}