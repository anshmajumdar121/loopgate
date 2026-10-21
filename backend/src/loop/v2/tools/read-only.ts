import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { TextDecoder } from "node:util";
import {
  MAX_FILE_BYTES,
  MAX_LIST_ENTRIES,
  MAX_READ_LINES,
  MAX_REPO_MAP_BYTES,
  MAX_SEARCH_MATCHES,
  defineTool,
  failure,
  success,
} from "./common.js";
import { checkReadPolicy, HIDDEN_DIRS, isContainedRelativePath, isDeniedPath, isHiddenPath, resolveContainedPath, ToolPolicyException } from "./policy.js";
import { ListDirInputSchema, ReadFileInputSchema, RepoMapInputSchema, SearchInputSchema } from "./schemas.js";
import type { ListDirInput, ReadFileInput, RepoMapInput, SearchInput } from "./schemas.js";
import type { ToolContext, ToolDefinition } from "./types.js";

const TEXT_EXTENSIONS = /\.[cm]?[jt]sx?$/i;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_MATCH_CONTEXT_BYTES = 1024;

export interface ListDirEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
}

export interface ListDirOutput {
  path: string;
  depth: number;
  entries: ListDirEntry[];
  truncated: boolean;
}

export interface ReadFileOutput {
  path: string;
  lines: string[];
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export interface SearchFile {
  path: string;
  content: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  context: string;
}

export interface SearchOutput {
  pattern: string;
  glob?: string;
  matches: SearchMatch[];
  truncated: boolean;
}

export interface RepoMapFile {
  path: string;
  content: string;
}

export interface RepoMapEntry {
  path: string;
  symbols: string[];
}

export interface RepoMapOutput {
  files: RepoMapEntry[];
  truncated: boolean;
  text: string;
}

export function formatLineWindow(source: string, startLine: number, endLine?: number): Omit<ReadFileOutput, "path"> & { path: string } {
  const all = source.split(/\r\n|\r|\n/);
  const start = Math.max(1, startLine);
  const requestedEnd = endLine ?? start + MAX_READ_LINES - 1;
  const actualEnd = Math.min(all.length, requestedEnd, start + MAX_READ_LINES - 1);
  return {
    path: "",
    lines: all.slice(start - 1, actualEnd).map((line, index) => `${start + index}: ${line}`),
    startLine: start,
    endLine: actualEnd,
    truncated: actualEnd < Math.min(all.length, requestedEnd),
  };
}

export function collectSearchMatches(files: readonly SearchFile[], regex: RegExp, glob?: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const file of files) {
    if (glob && !globMatches(file.path, glob)) continue;
    for (const [index, line] of file.content.split(/\r\n|\r|\n/).entries()) {
      regex.lastIndex = 0;
      if (!regex.test(line)) continue;
      const context = `${index + 1}: ${line}`;
      matches.push({
        path: file.path,
        line: index + 1,
        context: Buffer.from(context, "utf8").subarray(0, MAX_MATCH_CONTEXT_BYTES).toString("utf8"),
      });
      if (matches.length >= MAX_SEARCH_MATCHES) return matches;
    }
  }
  return matches;
}

export const listDirTool: ToolDefinition<
  ListDirInput,
  ListDirOutput
> = defineTool<ListDirInput, ListDirOutput>({
  name: "list_dir",
  roles: ["planner", "maker", "verifier"],
  description: "List visible files and directories under the workdir, bounded to depth three and 300 entries.",
  schema: ListDirInputSchema,
  handler: async (parsed, context) => {
    const target = await resolveContainedPath(context.workdir, parsed.path, "directory");
    const readPolicy = checkReadPolicy(target.relative);
    if (readPolicy) return failure(readPolicy.code, readPolicy.message, readPolicy.details);

    const entries: ListDirEntry[] = [];
    const root = await realpath(context.workdir);
    await visitDirectory(root, target.absolute, target.relative, parsed.depth, entries);
    const truncated = entries.length > MAX_LIST_ENTRIES;
    const output: ListDirOutput = {
      path: target.relative,
      depth: parsed.depth,
      entries: entries.slice(0, MAX_LIST_ENTRIES),
      truncated,
    };
    const content = output.entries
      .map((entry) => `${entry.kind === "directory" ? "d" : entry.kind === "symlink" ? "l" : "f"} ${entry.path}`)
      .join("\n") || "(empty directory)";
    return success(output, content, truncated);
  },
});

export const readFileTool: ToolDefinition<
  ReadFileInput,
  ReadFileOutput
> = defineTool<ReadFileInput, ReadFileOutput>({
  name: "read_file",
  roles: ["planner", "maker", "verifier"],
  description: "Read a bounded numbered line window from a text file.",
  schema: ReadFileInputSchema,
  handler: async (parsed, context) => {
    const target = await resolveContainedPath(context.workdir, parsed.path, "read");
    const readPolicy = checkReadPolicy(target.relative);
    if (readPolicy) return failure(readPolicy.code, readPolicy.message, readPolicy.details);
    const buffer = await readTextBuffer(target.absolute, parsed.path);
    const output = formatLineWindow(buffer.toString("utf8"), parsed.startLine, parsed.endLine);
    output.path = target.relative;
    const content = capLines(output.lines);
    output.lines = content.lines;
    output.truncated = output.truncated || content.truncated;
    return success(output, output.lines.join("\n"), output.truncated);
  },
});

export const searchTool: ToolDefinition<
  SearchInput,
  SearchOutput
> = defineTool<SearchInput, SearchOutput>({
  name: "search",
  roles: ["planner", "maker", "verifier"],
  description: "Search visible text files with a bounded JavaScript regular expression result set.",
  schema: SearchInputSchema,
  handler: async (parsed, context) => {
    if (parsed.glob !== undefined && !isContainedRelativePath(parsed.glob)) {
      return failure("policy:path-escape", `search glob escapes workdir: ${parsed.glob}`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(parsed.pattern);
    } catch (error) {
      return failure("tool:invalid-regex", error instanceof Error ? error.message : String(error));
    }
    const files = await collectTextFiles(context.workdir);
    const matches = collectSearchMatches(files, regex, parsed.glob);
    const truncated = matches.length >= MAX_SEARCH_MATCHES;
    const output: SearchOutput = {
      pattern: parsed.pattern,
      ...(parsed.glob === undefined ? {} : { glob: parsed.glob }),
      matches,
      truncated,
    };
    const content = matches.length === 0
      ? "No matches."
      : matches.map((match) => `${match.path}:${match.line}:${match.context}`).join("\n");
    return success(output, content, truncated);
  },
});

export const repoMapTool: ToolDefinition<
  RepoMapInput,
  RepoMapOutput
> = defineTool<RepoMapInput, RepoMapOutput>({
  name: "repo_map",
  roles: ["planner", "verifier"],
  description: "Return a compact map of visible source files and exported TypeScript/JavaScript symbols.",
  schema: RepoMapInputSchema,
  handler: async (_parsed, context) => {
    const files = await collectTextFiles(context.workdir);
    return success(repoMap(files));
  },
});

export function repoMap(files: readonly RepoMapFile[]): RepoMapOutput {
  const output: RepoMapOutput = { files: [], truncated: false, text: "" };
  const lines: string[] = [];
  let bytes = 0;
  for (const file of files
    .filter((entry) => TEXT_EXTENSIONS.test(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path))) {
    const symbols = extractSymbols(file.content);
    const line = `${file.path}${symbols.length > 0 ? ` — ${symbols.join(", ")}` : ""}`;
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + lineBytes > MAX_REPO_MAP_BYTES) {
      output.truncated = true;
      break;
    }
    output.files.push({ path: file.path, symbols });
    lines.push(line);
    bytes += lineBytes;
  }
  output.text = lines.join("\n");
  return output;
}

export async function collectTextFiles(root: string): Promise<SearchFile[]> {
  const realRoot = await realpath(root);
  const files: SearchFile[] = [];
  await walkVisibleFiles(realRoot, realRoot, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkVisibleFiles(root: string, directory: string, files: SearchFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (HIDDEN_DIRS.has(entry.name)) continue;
    const child = join(directory, entry.name);
    const childRelative = relative(root, child).replaceAll("\\", "/");
    if (isHiddenPath(childRelative) || isDeniedPath(childRelative)) continue;
    let info;
    try {
      info = await lstat(child);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      // Do not follow symlinks during broad observations. Direct tool paths
      // still resolve and fail closed if they escape the workdir.
      try {
        const resolved = await realpath(child);
        if (!isInside(root, resolved)) continue;
      } catch {
        continue;
      }
      continue;
    }
    if (info.isDirectory()) {
      await walkVisibleFiles(root, child, files);
      continue;
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
    try {
      const buffer = await readTextBuffer(child, childRelative);
      files.push({ path: childRelative, content: buffer.toString("utf8") });
    } catch {
      // Binary, unreadable, or concurrently removed files are omitted from a
      // bounded search/map observation.
    }
  }
}

async function visitDirectory(root: string, absolute: string, relativePath: string, depth: number, entries: ListDirEntry[]): Promise<void> {
  if (entries.length > MAX_LIST_ENTRIES) return;
  const children = await readdir(absolute, { withFileTypes: true });
  for (const childEntry of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entries.length > MAX_LIST_ENTRIES) return;
    if (HIDDEN_DIRS.has(childEntry.name)) continue;
    const child = join(absolute, childEntry.name);
    const childRelative = relative(root, child).replaceAll("\\", "/");
    if (isHiddenPath(childRelative) || isDeniedPath(childRelative)) continue;
    const info = await lstat(child);
    const kind: ListDirEntry["kind"] = info.isSymbolicLink()
      ? "symlink"
      : info.isDirectory()
      ? "directory"
      : "file";
    if (kind === "symlink") {
      try {
        const resolved = await realpath(child);
        if (!isInside(root, resolved)) continue;
      } catch {
        continue;
      }
    }
    entries.push({ path: childRelative, kind });
    if (kind === "directory" && depth > 1) {
      await visitDirectory(root, child, childRelative, depth - 1, entries);
    }
  }
}

function capLines(lines: string[]): { lines: string[]; truncated: boolean } {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const nextBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + nextBytes > 64 * 1024) {
      return { lines: [...kept, "[output truncated]"], truncated: true };
    }
    kept.push(line);
    bytes += nextBytes;
  }
  return { lines: kept, truncated: false };
}

async function readTextBuffer(path: string, displayPath: string): Promise<Buffer> {
  const details = await stat(path).catch((error) => {
    throw new ToolPolicyException("policy:not-found", `file does not exist: ${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!details.isFile()) throw new ToolPolicyException("policy:not-file", `not a regular file: ${displayPath}`);
  if (details.size > MAX_FILE_BYTES) throw new ToolPolicyException("policy:file-too-large", `${displayPath} exceeds 1 MiB`);
  const buffer = await readFile(path);
  if (buffer.includes(0)) throw new ToolPolicyException("policy:binary-file", `${displayPath} is binary`);
  try {
    UTF8_DECODER.decode(buffer);
  } catch {
    throw new ToolPolicyException("policy:binary-file", `${displayPath} is not valid UTF-8 text`);
  }
  return buffer;
}

function extractSymbols(content: string): string[] {
  const symbols: string[] = [];
  const patterns: Array<{ kind: string; pattern: RegExp }> = [
    { kind: "function", pattern: /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
    { kind: "class", pattern: /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g },
    { kind: "const", pattern: /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g },
    { kind: "type", pattern: /\bexport\s+(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g },
    { kind: "default", pattern: /\bexport\s+default\s+(?:(?:async\s+)?function|class)?\s*([A-Za-z_$][\w$]*)?/g },
  ];
  for (const { kind, pattern } of patterns) {
    for (const match of content.matchAll(pattern)) {
      const name = match[1] ?? "default";
      symbols.push(`${kind} ${name}`);
    }
  }
  for (const match of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const item of match[1].split(",")) {
      const name = item.trim().split(/\s+as\s+/i).at(-1)?.trim();
      if (name) symbols.push(`export ${name}`);
    }
  }
  return [...new Set(symbols)];
}

function globMatches(path: string, glob: string): boolean {
  let escaped = glob
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&");
  escaped = escaped
    .replace(/\*\*\//g, "\u0000LEADING\u0000")
    .replace(/\/\*\*/g, "\u0000TRAILING\u0000")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000LEADING\u0000/g, "(?:.*/)?")
    .replace(/\u0000TRAILING\u0000/g, "(?:/.*)?");
  const pattern = glob.includes("/") ? path : path.split("/").at(-1) ?? path;
  return new RegExp(`^${escaped}$`, "i").test(pattern);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}
