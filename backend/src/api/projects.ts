// REST endpoints for Projects. Kept separate from `tasks.ts` so task and
// project lifecycles can evolve independently.
//
// Endpoints:
//   GET    /api/projects              — list all
//   POST   /api/projects              — create
//   DELETE /api/projects/:id          — cascade delete (drops the project's
//                                       sessions, clears projectId+sessionId
//                                       on its tasks)
//   GET    /api/projects/:id/sessions — list sessions under one project
//                                       (composite; duplicates what sessions.ts
//                                       returns when filtered — kept for the
//                                       sidebar's project-expansion flow)

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  createProject,
  deleteProject,
  getProject,
  getProjectByRootPath,
  listProjects,
} from "../store/projects.js";
import {
  deleteSessionsForProject,
  listSessionsForProject,
} from "../store/sessions.js";
import { cleanOrphanTasks } from "../store/tasks.js";
import type { Project } from "../types.js";

export const projectsApi = new Hono();

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  rootPath: z.string().max(2000).optional(),
});

projectsApi.get("/projects", (c) => {
  return c.json({ projects: listProjects() });
});

/**
 * Look up an existing project by absolute rootPath. The New Project
 * modal calls this when the user picks a folder via Browse — if a
 * project already owns that path we surface it (200 with the project)
 * instead of letting the user create a duplicate.
 */
projectsApi.get("/projects/by-path", (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path query required" }, 400);
  const project = getProjectByRootPath(path);
  if (!project) return c.json({ project: null }, 200);
  return c.json({ project });
});

projectsApi.post(
  "/projects",
  zValidator("json", createSchema),
  (c) => {
    const body = c.req.valid("json") as {
      name: string;
      description?: string;
      rootPath?: string;
    };
    // Defensive duplicate check: refuse to create a project whose
    // rootPath matches an existing project. The frontend should call
    // /projects/by-path first to short-circuit this, but a 400 here
    // keeps the backend honest if the UI doesn't.
    if (body.rootPath) {
      const clash = getProjectByRootPath(body.rootPath);
      if (clash) {
        return c.json(
          {
            error: `a project already owns this path: "${clash.name}" (${clash.id})`,
            existingProject: clash,
          },
          409
        );
      }
    }
    const project: Project = createProject(body);
    return c.json({ project }, 201);
  }
);

projectsApi.get("/projects/:id/sessions", (c) => {
  const id = c.req.param("id");
  const project = getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);
  return c.json({ sessions: listSessionsForProject(id) });
});

projectsApi.delete("/projects/:id", (c) => {
  const id = c.req.param("id");
  const project = getProject(id);
  if (!project) return c.json({ error: "project not found" }, 404);
  deleteProject(id);
  // Cascade: 1) drop the project's sessions (otherwise they'd be orphans in
  // _sessions.json with no nav path to them), 2) clear projectId + sessionId
  // on tasks that referenced it. Tasks themselves are kept — the user can
  // decide whether to re-tag them under a different project.
  deleteSessionsForProject(id);
  cleanOrphanTasks({ projectId: id });
  return c.json({ ok: true });
});