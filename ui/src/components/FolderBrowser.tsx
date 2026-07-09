import { useEffect, useState, useCallback } from "react";
import {
  X,
  Folder,
  FolderOpen,
  ChevronRight,
  Home,
  ArrowLeft,
  FileText,
  Loader2,
  AlertTriangle,
  Check,
} from "lucide-react";

interface FolderBrowserProps {
  /** Initial directory to open. Defaults to user's home. */
  initialPath?: string;
  /** Called when the user picks a directory. The browser modal closes. */
  onSelect: (path: string) => void;
  onClose: () => void;
}

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number | null;
}

interface ListResponse {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

/**
 * Finder-style folder picker. Lists a directory on the SERVER's filesystem
 * (via GET /api/fs/list) so the user can navigate to the actual path the
 * backend will use as the agent's workdir.
 *
 * Why not `window.showDirectoryPicker()`: that returns a name-only handle
 * for security, which is useless here — we need the absolute path so the
 * spawned agent can `cd` into it.
 *
 * Layout:
 *   [ Breadcrumb: home › parent › current ]
 *   [ .. (parent directory) ]   <- shown when there's a parent
 *   [ d  folder-name          ]
 *   [ d  sub-folder           ]
 *   [ f  some-file.txt        ]
 *   [ Select ] [ Cancel ]
 */
export function FolderBrowser({
  initialPath,
  onSelect,
  onClose,
}: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(
    initialPath ?? null
  );
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Bootstrap: if no initialPath, fetch home first.
  useEffect(() => {
    if (currentPath === null) {
      void fetch("/api/fs/home")
        .then((r) => r.json() as Promise<{ home: string }>)
        .then((data) => setCurrentPath(data.home))
        .catch((e) => {
          setError(
            e instanceof Error ? e.message : "Failed to fetch home directory"
          );
          setLoading(false);
        });
    }
  }, [currentPath]);

  const refresh = useCallback(
    async (path: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/fs/list?path=${encodeURIComponent(path)}`;
        const res = await fetch(url);
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(data.error ?? `HTTP ${res.status}`);
          setEntries([]);
          setParent(null);
          return;
        }
        const data = (await res.json()) as ListResponse;
        setCurrentPath(data.path);
        setParent(data.parent);
        setEntries(data.entries);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (currentPath) {
      void refresh(currentPath);
    }
  }, [currentPath, refresh]);

  const breadcrumbs = currentPath
    ? splitPath(currentPath)
    : [];

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex h-[640px] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            title="Back"
          >
            <ArrowLeft size={14} />
          </button>
          <div className="grid h-7 w-7 place-items-center rounded-md bg-violet-500/15 text-violet-300">
            <FolderOpen size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold">Pick a workdir</h2>
            <p className="truncate text-[11px] text-zinc-500">
              {currentPath ?? "Loading…"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2 text-[11.5px]">
          {breadcrumbs.map((part, i) => (
            <span key={i} className="flex items-center">
              {i > 0 && (
                <ChevronRight
                  size={11}
                  className="mx-0.5 text-zinc-600"
                />
              )}
              <button
                type="button"
                onClick={() => {
                  const path = breadcrumbs
                    .slice(0, i + 1)
                    .join("/");
                  setCurrentPath(path);
                }}
                className={`rounded px-1.5 py-0.5 hover:bg-zinc-800 ${
                  i === 0 ? "" : "text-zinc-300"
                } ${i === breadcrumbs.length - 1 ? "text-violet-300" : ""}`}
                title={breadcrumbs.slice(0, i + 1).join("/")}
              >
                {part || "/"}
              </button>
            </span>
          ))}
          {parent && (
            <button
              type="button"
              onClick={() => setCurrentPath(parent)}
              className="ml-2 inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              title="Up one level"
            >
              <ChevronRight size={11} className="rotate-180" />
              Up
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center gap-2 px-4 py-8 text-[12px] text-zinc-500">
              <Loader2 size={13} className="animate-spin" />
              Loading…
            </div>
          )}
          {!loading && error && (
            <div className="m-4 flex items-start gap-2 rounded-md bg-rose-500/10 px-3 py-2 text-[12px] text-rose-300">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}
          {!loading && !error && (
            <ul className="divide-y divide-zinc-800/60">
              {parent && (
                <DirectoryRow
                  icon={<ChevronRight size={13} className="rotate-180" />}
                  label=".."
                  sub={parent}
                  onClick={() => setCurrentPath(parent)}
                />
              )}
              {entries.length === 0 && !parent && (
                <li className="px-4 py-8 text-center text-[12px] text-zinc-500">
                  This folder is empty.
                </li>
              )}
              {entries.map((e) => (
                <DirectoryRow
                  key={e.path}
                  icon={
                    e.isDirectory ? (
                      <Folder size={13} className="text-amber-500" />
                    ) : (
                      <FileText size={13} className="text-zinc-500" />
                    )
                  }
                  label={e.name}
                  sub={
                    e.isDirectory
                      ? "folder"
                      : e.size !== null
                      ? formatBytes(e.size)
                      : "file"
                  }
                  onClick={() => {
                    if (e.isDirectory) setCurrentPath(e.path);
                  }}
                  doubleClickSelect={
                    e.isDirectory ? () => onSelect(e.path) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <button
            type="button"
            onClick={() => {
              if (currentPath) setCurrentPath(currentPath);
              // Otherwise: just reload whatever we're on after fetch.
            }}
            disabled={loading}
            className="text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
          >
            ↻ Reload
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-8 rounded-md px-3 text-[12px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              Cancel
            </button>
            <button
              onClick={() => currentPath && onSelect(currentPath)}
              disabled={!currentPath || loading}
              className="flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-4 text-[12px] font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            >
              <Check size={12} />
              Select this folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DirectoryRow({
  icon,
  label,
  sub,
  onClick,
  doubleClickSelect,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  onClick: () => void;
  doubleClickSelect?: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        onDoubleClick={doubleClickSelect}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12.5px] text-zinc-200 hover:bg-zinc-800/60"
      >
        <span className="grid w-5 place-items-center">{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        <span className="text-[10.5px] text-zinc-500">{sub}</span>
      </button>
    </li>
  );
}

/**
 * Split a POSIX-style path into breadcrumb parts. `/foo/bar/baz` →
 * `["", "foo", "bar", "baz"]`. Empty root returns `[""]`.
 */
function splitPath(p: string): string[] {
  if (!p) return [""];
  if (p === "/") return [""];
  const parts = p.split("/").filter(Boolean);
  // The first segment is the leading "" for the root, then each segment.
  return ["", ...parts];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}