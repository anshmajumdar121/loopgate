import { z } from "zod";

export const ListDirInputSchema = z.object({
  path: z.string().min(1).default("."),
  depth: z.number().int().min(0).max(3).default(1),
}).strict();

export const ReadFileInputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().default(1),
  endLine: z.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.endLine !== undefined && value.endLine < value.startLine) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endLine"], message: "endLine must be >= startLine" });
  }
  if (value.endLine !== undefined && value.endLine - value.startLine + 1 > 200) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endLine"], message: "read window must be at most 200 lines" });
  }
});

export const SearchInputSchema = z.object({
  pattern: z.string().min(1),
  glob: z.string().min(1).optional(),
}).strict();

export const RepoMapInputSchema = z.object({}).strict();

export const WriteFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(1_048_576),
}).strict();

export const ApplyPatchInputSchema = z.object({
  path: z.string().min(1),
  unifiedDiff: z.string().min(1).max(262_144),
}).strict();

export const RunCheckInputSchema = z.object({
  id: z.string().min(1),
}).strict();

export type ListDirInput = z.output<typeof ListDirInputSchema>;
export type ReadFileInput = z.output<typeof ReadFileInputSchema>;
export type SearchInput = z.output<typeof SearchInputSchema>;
export type RepoMapInput = z.output<typeof RepoMapInputSchema>;
export type WriteFileInput = z.output<typeof WriteFileInputSchema>;
export type ApplyPatchInput = z.output<typeof ApplyPatchInputSchema>;
export type RunCheckInput = z.output<typeof RunCheckInputSchema>;
