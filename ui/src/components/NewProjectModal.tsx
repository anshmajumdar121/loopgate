import { useState, useEffect } from "react";
import {
  Plus,
  X,
  Folder,
  FolderOpen,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import type { Project } from "@/types/loop";
import { FolderBrowser } from "@/components/FolderBrowser";

interface NewProjectModalProps {
  onClose: () => void;
  onCreated: (project: Project) => void;
  /**
   * Optional callback when the user picks a folder that already has a
   * project rootPath. Lets the parent close this modal and open / focus
   * that project instead of creating a duplicate.
   */
  onOpenExisting?: (project: Project) => void;
}

/**
 * New Project modal. Fields:
 *   - Project name (required)
 *   - Description (optional)
 *   - Project root folder (optional, pickable via Browse button)
 *
 * Two outcome modes when the user picks a rootPath:
 *
 *   1. Path is FREE — backend creates a new project, modal closes.
 *
 *   2. Path is OWNED BY ANOTHER PROJECT — backend returns 409 (and the
 *      /by-path lookup is checked up front). The modal flips into
 *      "Open existing" mode: shows which project owns the path, with
 *      an "Open that project" button. We don't create a duplicate.
 *
 * The Browse button reuses the same `FolderBrowser` modal the New Task
 * modal uses for picking a workdir — same look-and-feel, same REST API.
 */
export function NewProjectModal({
  onClose,
  onCreated,
  onOpenExisting,
}: NewProjectModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  // When the picked folder already belongs to another project, we flip
  // into this "duplicate detected" mode and stop the create flow.
  const [collision, setCollision] = useState<Project | null>(null);

  // If the user changes the path manually after a collision was detected,
  // clear the collision so they can try again.
  useEffect(() => {
    if (collision) setCollision(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Project name required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Pre-flight: if the user picked a path, check if a project already
      // owns it. This is the polite UX path — backend also enforces this
      // (returns 409) but doing it client-side lets us flip into the
      // "open existing" state with a clean affordance.
      if (rootPath.trim()) {
        const check = await fetch(
          `/api/projects/by-path?path=${encodeURIComponent(rootPath.trim())}`
        );
        if (check.ok) {
          const data = (await check.json()) as { project: Project | null };
          if (data.project) {
            setCollision(data.project);
            setSubmitting(false);
            return;
          }
        }
      }
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          description: description.trim() || undefined,
          rootPath: rootPath.trim() || undefined,
        }),
      });
      if (res.status === 409) {
        const data = (await res.json().catch(() => ({}))) as {
          existingProject?: Project;
          error?: string;
        };
        if (data.existingProject) {
          setCollision(data.existingProject);
          return;
        }
        setError(data.error ?? "Path already in use");
        return;
      }
      if (!res.ok) {
        throw new Error(`POST /api/projects → ${res.status}`);
      }
      const data = (await res.json()) as { project: Project };
      onCreated(data.project);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 backdrop-blur-sm"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-[520px] max-w-[92vw] max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Folder size={16} className="text-violet-600" />
            <h2 className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
              New Project
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X size={15} />
          </button>
        </div>

        {/* Collision banner — replaces the create form when the picked
         * folder already belongs to another project. */}
        {collision ? (
          <CollisionView
            existing={collision}
            onOpen={() => {
              onClose();
              onOpenExisting?.(collision);
            }}
            onOverride={async () => {
              // User wants to force-create a new project on the same path.
              // Backend doesn't currently support this (it 409s) — we
              // surface that error so the user knows.
              setCollision(null);
              setError(
                `Cannot create — "${collision.name}" already owns that path. Open that project or pick a different folder.`
              );
            }}
            onCancel={() => {
              setCollision(null);
              setRootPath("");
            }}
          />
        ) : (
          <>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Project name
            </label>
            <input
              autoFocus
              type="text"
              placeholder="e.g. Loop Agent, OpenFlowCut, …"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  name.trim() &&
                  !submitting
                )
                  void handleCreate();
              }}
              className="h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-[13px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />

            <label className="mb-1.5 mt-3 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Description (optional)
            </label>
            <textarea
              rows={2}
              placeholder="Short note about this workspace."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-3 py-2 text-[13px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />

            <label className="mb-1.5 mt-3 block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Project root folder (optional)
            </label>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="/path/to/your/project — or pick one with Browse"
                className="h-9 flex-1 rounded-lg border border-zinc-300 bg-white px-3 font-mono text-[12px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              <button
                type="button"
                onClick={() => setShowFolderBrowser(true)}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                title="Browse the server's filesystem"
              >
                <FolderOpen size={13} />
                Browse
              </button>
            </div>
            <p className="mt-1.5 text-[10.5px] text-zinc-500 dark:text-zinc-400">
              Anchors the project to a real folder. Tasks under this
              project land in sub-folders of the path you pick.
            </p>

            {error && (
              <div className="mt-3 flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <AlertTriangle
                  size={13}
                  className="mt-0.5 shrink-0"
                />
                {error}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                disabled={submitting}
                className="h-9 rounded-md px-4 text-[13px] font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim() || submitting}
                className="flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-4 text-[13px] font-medium text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-50"
              >
                <Plus size={13} />
                {submitting ? "Creating…" : "Create Project"}
              </button>
            </div>
          </>
        )}
      </div>

      {showFolderBrowser && (
        <FolderBrowser
          initialPath={rootPath || undefined}
          onSelect={(p) => {
            setRootPath(p);
            setShowFolderBrowser(false);
          }}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}
    </div>
  );
}

/**
 * Replaces the create form when the user picks a folder that another
 * project already owns. Offers: open the existing project, override
 * (kept for symmetry but currently we don't allow duplicates — backend
 * 409s), or cancel and pick a different folder.
 */
function CollisionView({
  existing,
  onOpen,
  onOverride,
  onCancel,
}: {
  existing: Project;
  onOpen: () => void;
  onOverride: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <span>
          That folder already belongs to{" "}
          <strong className="font-semibold">{existing.name}</strong>.
          Pick a different folder or open the existing project.
        </span>
      </div>
      <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
        <div className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
          {existing.name}
        </div>
        {existing.description && (
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {existing.description}
          </div>
        )}
        {existing.rootPath && (
          <code className="mt-1 block truncate font-mono text-[10.5px] text-zinc-500">
            {existing.rootPath}
          </code>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="h-9 rounded-md px-3 text-[12.5px] font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Pick a different folder
        </button>
        <button
          onClick={onOpen}
          className="flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-4 text-[13px] font-medium text-white shadow-sm transition hover:bg-violet-700"
        >
          Open <strong>{existing.name}</strong>
          <ArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}