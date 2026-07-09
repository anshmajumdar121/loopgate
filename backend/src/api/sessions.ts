// REST endpoints for Sessions. A Session always belongs to a Project.
// On delete, tasks that referenced the session have their sessionId
// cleared (but keep their projectId — they're still in the project).

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { cleanOrphanTasks } from "../store/tasks.js";
import { getProject } from "../store/projects.js";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  listSessionsForProject,
} from "../store/sessions.js";
import type { Session } from "../types.js";

export const sessionsApi = new Hono();

const createSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

sessionsApi.get("/sessions", (c) => {
  const projectId = c.req.query("projectId");
  if (projectId) {
    return c.json({ sessions: listSessionsForProject(projectId) });
  }
  return c.json({ sessions: listSessions() });
});

sessionsApi.post(
  "/sessions",
  zValidator("json", createSchema),
  (c) => {
    const body = c.req.valid("json") as {
      projectId: string;
      name: string;
      description?: string;
    };
    const project = getProject(body.projectId);
    if (!project) {
      return c.json(
        { error: `project ${body.projectId} not found` },
        400
      );
    }
    const session: Session = createSession(body);
    return c.json({ session }, 201);
  }
);

sessionsApi.delete("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "session not found" }, 404);
  deleteSession(id);
  cleanOrphanTasks({ sessionId: id });
  return c.json({ ok: true });
});