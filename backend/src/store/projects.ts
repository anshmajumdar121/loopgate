// In-memory store of Projects + Sessions with JSON persistence. Mirrors
// `tasks.ts` — same shape, separate file because the lifecycle
// (create/load/save) is small but distinct enough to keep readable.

import { nanoid } from "nanoid";
import type { Project, Session } from "../types.js";
import { loadAllProjects, saveProjects } from "./persistence.js";

interface ProjectStore {
  projects: Project[];
}

const projectStore: ProjectStore = { projects: [] };

export function listProjects(): Project[] {
  return [...projectStore.projects].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1
  );
}

export function getProject(id: string): Project | undefined {
  return projectStore.projects.find((p) => p.id === id);
}

/**
 * Look up a project by its absolute rootPath. Used by the New Project
 * modal to detect "you're picking a folder that's already a project"
 * — when that happens we surface the existing project instead of
 * creating a duplicate.
 *
 * Match is exact: case-sensitive, normalised. Symlinks aren't resolved
 * (the user picked a specific string; we just compare strings).
 */
export function getProjectByRootPath(rootPath: string): Project | undefined {
  if (!rootPath) return undefined;
  const target = rootPath.replace(/\/+$/, ""); // strip trailing slash
  return projectStore.projects.find(
    (p) =>
      p.rootPath && p.rootPath.replace(/\/+$/, "") === target
  );
}

export function createProject(input: {
  name: string;
  description?: string;
  rootPath?: string;
}): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: nanoid(12),
    name: input.name.trim() || "Untitled project",
    description: input.description?.trim() || undefined,
    rootPath: input.rootPath?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  projectStore.projects.push(project);
  void saveProjects(projectStore.projects).catch((err) => {
    console.error(`[store] Failed to save project ${project.id}:`, err);
  });
  return project;
}

export function deleteProject(id: string): boolean {
  const idx = projectStore.projects.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  projectStore.projects.splice(idx, 1);
  void saveProjects(projectStore.projects).catch((err) => {
    console.error(`[store] Failed to save projects after delete:`, err);
  });
  return true;
}

/** Bulk-load at startup. Replaces any in-memory state. */
export function loadProjectsFromDisk(projects: Project[]): void {
  projectStore.projects = projects;
}