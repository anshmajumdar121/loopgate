import { z } from "zod";

const TOOL_NAMES = ["npm", "npx", "node", "pnpm", "yarn"] as const;
const SCRIPT_NAMES = ["build", "lint", "typecheck"] as const;

/**
 * The only command shapes the deterministic runner may execute. Extra
 * arguments are allowed after the safe verb so flags such as `--run` and
 * `--no-cache` can be passed without turning this into a shell command.
 */
export function isAllowedCheckCommand(command: readonly string[]): boolean {
  if (command.length < 2) return false;
  const [tool, verb, third] = command;
  if (!(TOOL_NAMES as readonly string[]).includes(tool)) return false;

  if (verb === "test") return true;
  if (verb === "run" && (SCRIPT_NAMES as readonly string[]).includes(third ?? "")) {
    return true;
  }
  if (verb === "tsc" || verb === "vitest") return true;
  // `npx vitest run` is the common direct invocation; accepting `node
  // vitest` would be misleading, so keep the allowlist anchored to the
  // named tools/verbs above.
  return false;
}

export const CheckCommandSchema = z
  .array(z.string().min(1))
  .min(2)
  .refine(isAllowedCheckCommand, {
    message:
      "check command must be npm|npx|node|pnpm|yarn with test, run build/lint/typecheck, tsc, or vitest",
  });

export const PlanCheckSchema = z.object({
  id: z.string().min(1),
  cmd: CheckCommandSchema,
  timeoutMs: z.number().int().positive().max(30 * 60_000),
});

export const PlanCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

export const PlanSchema = z.object({
  criteria: z.array(PlanCriterionSchema),
  filesToTouch: z.array(z.string().min(1)),
  checks: z.array(PlanCheckSchema),
});

export const VerdictEvidenceSchema = z.object({
  kind: z.enum(["check", "file"]),
  ref: z.string().min(1),
});

export const VerdictCriterionSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  evidence: VerdictEvidenceSchema,
});

export const VerdictSchema = z.object({
  attempt: z.number().int().positive(),
  outcome: z.enum(["APPROVE", "REJECT", "ESCALATE"]),
  criteria: z.array(VerdictCriterionSchema),
  requiredFixes: z.array(z.string()),
});

export type PlanSchema = z.infer<typeof PlanSchema>;
export type PlanCheck = z.infer<typeof PlanCheckSchema>;
export type PlanCriterion = z.infer<typeof PlanCriterionSchema>;
export type VerdictSchema = z.infer<typeof VerdictSchema>;
export type VerdictCriterion = z.infer<typeof VerdictCriterionSchema>;

export interface StructuredVerdictParse {
  verdict: VerdictSchema | null;
  /** A fenced JSON verdict was present but failed schema validation. */
  malformed: boolean;
  error?: string;
}

/**
 * Parse the optional verifier-owned fenced JSON block. A present block is
 * authoritative: malformed JSON or a schema mismatch is never silently
 * downgraded to the permissive markdown parser.
 */
export function parseStructuredVerdict(text: string): StructuredVerdictParse {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) return { verdict: null, malformed: false };

  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch (error) {
    return {
      verdict: null,
      malformed: true,
      error: `malformed verdict JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = VerdictSchema.safeParse(value);
  if (!parsed.success) {
    return {
      verdict: null,
      malformed: true,
      error: `malformed verdict: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"} ${issue.message}`)
        .join("; ")}`,
    };
  }
  return { verdict: parsed.data, malformed: false };
}

export function makeMalformedVerdict(
  attempt: number,
  reason: string,
): VerdictSchema {
  return {
    attempt,
    outcome: "REJECT",
    criteria: [],
    requiredFixes: [reason || "malformed verdict"],
  };
}
