// In-memory store of Sessions + JSON persistence. Sessions always
// belong to exactly one project — the API rejects session creation
// without a projectId.

import { nanoid } from "nanoid";
import type { Session } from "../types.js";
import { loadAllSessions, saveSessions } from "./persistence.js";

interface SessionStore {
  sessions: Session[];
}

const sessionStore: SessionStore = { sessions: [] };

export function listSessions(): Session[] {
  return [...sessionStore.sessions].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1
  );
}

export function listSessionsForProject(projectId: string): Session[] {
  return sessionStore.sessions
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export function getSession(id: string): Session | undefined {
  return sessionStore.sessions.find((s) => s.id === id);
}

export function createSession(input: {
  projectId: string;
  name: string;
  description?: string;
}): Session {
  const now = new Date().toISOString();
  const session: Session = {
    id: nanoid(12),
    projectId: input.projectId,
    name: input.name.trim() || "Untitled session",
    description: input.description?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  sessionStore.sessions.push(session);
  void saveSessions(sessionStore.sessions).catch((err) => {
    console.error(`[store] Failed to save session ${session.id}:`, err);
  });
  return session;
}

export function deleteSession(id: string): boolean {
  const idx = sessionStore.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  sessionStore.sessions.splice(idx, 1);
  void saveSessions(sessionStore.sessions).catch((err) => {
    console.error(`[store] Failed to save sessions after delete:`, err);
  });
  return true;
}

/**
 * Delete every session that belongs to a project. Called from the projects
 * DELETE handler — without it, cascade-deleting a project would leave orphan
 * session rows in `_sessions.json` that no UI nav path can reach.
 * Returns the number of sessions removed.
 */
export function deleteSessionsForProject(projectId: string): number {
  const before = sessionStore.sessions.length;
  sessionStore.sessions = sessionStore.sessions.filter(
    (s) => s.projectId !== projectId
  );
  const removed = before - sessionStore.sessions.length;
  if (removed > 0) {
    void saveSessions(sessionStore.sessions).catch((err) => {
      console.error(`[store] Failed to save sessions after bulk delete:`, err);
    });
  }
  return removed;
}

export function loadSessionsFromDisk(sessions: Session[]): void {
  sessionStore.sessions = sessions;
}