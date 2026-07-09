import { useState, useEffect, useMemo } from "react";
import {
  X,
  Eye,
  EyeOff,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Check,
} from "lucide-react";
import {
  PROVIDER_PRESETS,
  presetFor,
  type ProviderPreset,
} from "@/lib/providerPresets";
import type {
  Connection,
  ConnectionProviderId,
  ConnectionRole,
} from "@/types/loop";

interface NewConnectionModalProps {
  /** When set, the modal starts in "edit" mode pre-filled with this
   *  connection. The apiKey field starts blank (submitting blank means
   *  "keep existing"). */
  initial?: Connection | null;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    description?: string;
    providerId?: ConnectionProviderId;
    providerType: Connection["providerType"];
    baseUrl: string;
    apiKey?: string;
    model?: string;
    modelLabel?: string;
    temperature?: number;
    roles?: ConnectionRole[];
  }) => Promise<void>;
}

const TEMPERATURE_LABELS: Array<{ at: number; label: string }> = [
  { at: 0.0, label: "precise" },
  { at: 0.5, label: "balanced" },
  { at: 1.0, label: "creative" },
];

/** The three agent roles a user can dedicate a connection to. Mirrors the
 *  NodeGroup ids in lib/nodeGroups.ts. `orchestration` is intentionally NOT
 *  here — the orchestrator is system-level (no LLM), per the existing
 *  NODE_GROUPS definition. */
const ROLE_OPTIONS: Array<{ id: ConnectionRole; label: string; description: string }> = [
  {
    id: "planning",
    label: "Planning",
    description: "Used for the loop-planner agent.",
  },
  {
    id: "implementation",
    label: "Implementation",
    description: "Used for the loop-maker agent.",
  },
  {
    id: "review",
    label: "Review",
    description: "Used for the loop-verifier agent.",
  },
];

/**
 * "Manual setup" connection form. Fields:
 *
 *   PROVIDER  (dropdown — drives defaults below)
 *   ENDPOINT  (URL, prefilled from preset)
 *   API KEY   (password input, prefilled hint from preset)
 *   MODEL     (dropdown from preset's catalog, with "Custom..." option)
 *   DEDICATED TO  (chips — pick which agent role(s) this connection serves)
 *   TEMPERATURE  (slider 0..1, default from preset)
 *   [ Save settings ]
 *
 * Theme matches the rest of the UI: violet accents on zinc-950, no amber.
 *
 * One connection = one (provider, endpoint, key, model, roles, temperature)
 * profile. The user picks which role(s) the connection is dedicated to
 * via the chips; the connection then appears at the top of the model
 * picker for each chosen role with a "Dedicated" badge.
 */
export function NewConnectionModal({
  initial,
  onClose,
  onSubmit,
}: NewConnectionModalProps) {
  const isEdit = Boolean(initial);

  // Provider drives defaults below. Initialised from the existing
  // connection's `providerId` when editing, otherwise to OpenRouter.
  const [providerId, setProviderId] = useState<ConnectionProviderId>(
    initial?.providerId ?? "openrouter"
  );
  const preset = useMemo(() => presetFor(providerId), [providerId]);

  const [name, setName] = useState(initial?.name ?? "");
  const [endpoint, setEndpoint] = useState(
    initial?.baseUrl ?? preset.defaultBaseUrl
  );
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [model, setModel] = useState(
    initial?.model ?? preset.models[0]?.id ?? ""
  );
  const [customModel, setCustomModel] = useState(
    initial?.model && !preset.models.some((m) => m.id === initial.model)
      ? initial.model
      : ""
  );
  const [useCustomModel, setUseCustomModel] = useState(
    Boolean(initial?.model && !preset.models.some((m) => m.id === initial.model))
  );
  const [roles, setRoles] = useState<ConnectionRole[]>(initial?.roles ?? []);
  const [temperature, setTemperature] = useState<number>(
    initial?.temperature ?? preset.temperatureDefault
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When the user changes provider, re-apply the preset's defaults —
  // endpoint, first model, temperature — in BOTH create and edit modes.
  // The connection's `name` is preserved (user-set, not provider-derived).
  // apiKey is preserved (may still be valid across provider changes if
  // it's a generic key). Roles are preserved.
  useEffect(() => {
    setEndpoint(preset.defaultBaseUrl);
    setModel(preset.models[0]?.id ?? "");
    setUseCustomModel(false);
    setCustomModel("");
    setTemperature(preset.temperatureDefault);
  }, [providerId, preset]);

  const toggleRole = (r: ConnectionRole) => {
    setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    const trimmedEndpoint = endpoint.trim();
    const finalModel = useCustomModel ? customModel.trim() : model.trim();
    if (!trimmedName) return setError("Connection name required");
    if (!trimmedEndpoint) return setError("Endpoint URL required");
    try {
      new URL(trimmedEndpoint);
    } catch {
      return setError("Endpoint must be a full URL (https://...)");
    }
    if (useCustomModel && !customModel.trim()) {
      return setError("Custom model id required");
    }
    setSubmitting(true);
    setError(null);
    try {
      const modelLabel = useCustomModel
        ? undefined
        : preset.models.find((m) => m.id === model)?.label;
      const apiKeyField: string | undefined = isEdit
        ? apiKey === ""
          ? undefined
          : apiKey.trim() || ""
        : apiKey.trim() || undefined;
      await onSubmit({
        name: trimmedName,
        providerId,
        providerType: preset.providerType,
        baseUrl: trimmedEndpoint,
        apiKey: apiKeyField,
        model: finalModel || undefined,
        modelLabel,
        temperature,
        roles: roles.length > 0 ? roles : undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Theme tokens — match the rest of the UI (violet, not amber) ──
  const sectionLabel =
    "block text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-400/80";
  const fieldBase =
    "h-10 w-full rounded-xl border border-zinc-700 bg-zinc-900/70 px-3.5 text-[13px] text-zinc-100 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-400/20";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="relative w-[520px] max-w-[94vw] max-h-[92vh] overflow-y-auto rounded-3xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-5 flex items-start justify-between">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-400">
              Manual Setup
            </div>
            <h2 className="text-[20px] font-semibold tracking-tight">
              {isEdit ? "Edit AI provider" : "AI provider"}
            </h2>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onClose}
              disabled={submitting}
              className="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              title="Back"
            >
              <ArrowLeft size={15} />
            </button>
            <button
              onClick={onClose}
              disabled={submitting}
              className="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              title="Close"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* PROVIDER */}
        <div className="mt-4">
          <label className={sectionLabel}>Provider</label>
          <select
            value={providerId}
            onChange={(e) =>
              setProviderId(e.target.value as ConnectionProviderId)
            }
            className={`${fieldBase} mt-1.5 appearance-none pr-9`}
          >
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11.5px] leading-snug text-zinc-500">
            {preset.description}
          </p>
        </div>

        {/* NAME */}
        <div className="mt-4">
          <label className={sectionLabel}>Connection name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              isEdit
                ? initial?.name ?? "e.g. OpenRouter (planning)"
                : `e.g. ${preset.name} (planning)`
            }
            className={`${fieldBase} mt-1.5`}
          />
          <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            Friendly label shown in the connections list and the model
            picker. Helps you tell multiple connections apart when they're
            for the same provider.
          </p>
        </div>

        {/* ENDPOINT */}
        <div className="mt-4">
          <label className={sectionLabel}>Endpoint</label>
          <input
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={preset.endpointHint}
            className={`${fieldBase} mt-1.5 font-mono text-[12px]`}
          />
        </div>

        {/* API KEY */}
        {!preset.noKey && (
          <div className="mt-4">
            <label className={sectionLabel}>API Key</label>
            <div className="relative mt-1.5">
              <input
                type={apiKeyVisible ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  isEdit
                    ? "(leave blank to keep existing key)"
                    : preset.apiKeyHint
                }
                autoComplete="off"
                spellCheck={false}
                className={`${fieldBase} pr-10 font-mono text-[12px]`}
              />
              <button
                type="button"
                onClick={() => setApiKeyVisible((v) => !v)}
                className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                title={apiKeyVisible ? "Hide" : "Show"}
              >
                {apiKeyVisible ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            {isEdit && initial?.hasApiKey && (
              <p className="mt-1.5 flex items-center gap-1 text-[10.5px] text-emerald-400">
                <CheckCircle2 size={10} />
                Key currently set — submit empty to keep it
              </p>
            )}
          </div>
        )}

        {/* MODEL */}
        <div className="mt-4">
          <label className={sectionLabel}>Model</label>
          {preset.models.length === 0 ? (
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. my-custom-model-id"
              className={`${fieldBase} mt-1.5 font-mono text-[12px]`}
            />
          ) : useCustomModel ? (
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. my-provider/some-model"
              className={`${fieldBase} mt-1.5 font-mono text-[12px]`}
            />
          ) : (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={`${fieldBase} mt-1.5 appearance-none pr-9 font-mono text-[12px]`}
            >
              {preset.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </select>
          )}
          {preset.models.length > 0 && !useCustomModel && (
            <button
              type="button"
              onClick={() => {
                setUseCustomModel(true);
                setCustomModel(model);
              }}
              className="mt-1.5 text-[11px] text-violet-400 hover:text-violet-300"
            >
              Don't see your model? Type a custom id →
            </button>
          )}
          {useCustomModel && preset.models.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setUseCustomModel(false);
                setModel(preset.models[0]?.id ?? "");
              }}
              className="mt-1.5 text-[11px] text-violet-400 hover:text-violet-300"
            >
              ← Back to preset list
            </button>
          )}
        </div>

        {/* DEDICATED TO — role chips */}
        <div className="mt-5">
          <div className="flex items-baseline justify-between">
            <label className={sectionLabel}>Dedicated to</label>
            <span className="text-[10px] text-zinc-500">
              {roles.length === 0
                ? "general — picker default"
                : `${roles.length} role${roles.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-zinc-500">
            Pick which agent phase this provider should power. Selected
            roles sort the connection to the top of the model picker with a
            "Dedicated" badge. Leave empty to make it a general-purpose
            option.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {ROLE_OPTIONS.map((opt) => {
              const active = roles.includes(opt.id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => toggleRole(opt.id)}
                  disabled={submitting}
                  title={opt.description}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                    active
                      ? "border-violet-500 bg-violet-500/15 text-violet-200"
                      : "border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800"
                  }`}
                >
                  <span
                    className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${
                      active
                        ? "border-violet-300 bg-violet-400"
                        : "border-zinc-600"
                    }`}
                  >
                    {active && <Check size={9} className="text-zinc-950" strokeWidth={3.5} />}
                  </span>
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* TEMPERATURE */}
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <label className={sectionLabel}>Temperature</label>
            <span className="font-mono text-[11px] tabular-nums text-zinc-400">
              {temperature.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
            className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-800 accent-violet-500"
          />
          <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wider text-zinc-500">
            {TEMPERATURE_LABELS.map((tl) => (
              <span
                key={tl.label}
                className={Math.abs(temperature - tl.at) < 0.05 ? "text-violet-300" : ""}
              >
                {tl.label}
              </span>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-md bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        {/* SAVE — violet to match the UI */}
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="mt-6 flex h-11 w-full items-center justify-center rounded-2xl bg-gradient-to-r from-violet-600 to-violet-500 text-[14px] font-semibold text-white shadow-lg shadow-violet-500/20 transition hover:from-violet-500 hover:to-violet-400 disabled:opacity-50"
        >
          {submitting ? "Saving settings…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}

export type { ProviderPreset };