import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ITEM_STATUSES,
  InvalidItemEventError,
  ItemEvent,
  ItemMetadata,
  ItemState,
  ItemStatus,
  createItemCreatedEvent,
  projectItem,
  reduceItem,
  transitionItem,
} from "./state-machine.js";

/*
 * better-sqlite3 does not ship TypeScript declarations in this project. Keep
 * the dependency local to this module and type only the small surface used by
 * the event log rather than weakening the rest of the backend's type checks.
 */
interface SqliteStatement {
  run(...parameters: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(...parameters: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...parameters: unknown[]): T[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

type SqliteDatabaseConstructor = new (filename: string) => SqliteDatabase;
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as SqliteDatabaseConstructor;

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    attempt_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS items_run_id_idx ON items(run_id);

  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(item_id, number)
  );

  CREATE INDEX IF NOT EXISTS attempts_item_id_idx ON attempts(item_id);
  CREATE INDEX IF NOT EXISTS attempts_run_id_idx ON attempts(run_id);

  CREATE TABLE IF NOT EXISTS events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
    version INTEGER NOT NULL,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(item_id, version)
  );

  CREATE INDEX IF NOT EXISTS events_run_sequence_idx ON events(run_id, sequence);
  CREATE INDEX IF NOT EXISTS events_item_sequence_idx ON events(item_id, sequence);

  CREATE TRIGGER IF NOT EXISTS events_append_only_update
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events table is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS events_append_only_delete
  BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events table is append-only');
  END;
`;

const ATTEMPT_FINISH_STATUSES = new Set<ItemStatus>([
  "approved",
  "rejected",
  "escalated",
  "cancelled",
  "failed",
]);

export interface EventLogOptions {
  now?: () => string;
  idFactory?: () => string;
}

export interface RunRecord {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  metadata: ItemMetadata;
}

export interface ItemRecord {
  id: string;
  runId: string;
  status: ItemStatus;
  attempt: number;
  attemptId?: string;
  createdAt: string;
  updatedAt: string;
  metadata: ItemMetadata;
}

export interface AttemptRecord {
  id: string;
  runId: string;
  itemId: string;
  number: number;
  status: string;
  startedAt: string;
  finishedAt?: string;
  metadata: ItemMetadata;
}

export interface StoredEvent {
  sequence: number;
  eventId: string;
  runId: string;
  itemId?: string;
  attemptId?: string;
  version: number;
  type: string;
  occurredAt: string;
  payload: unknown;
}

export interface CreateRunInput {
  id?: string;
  status?: string;
  createdAt?: string;
  metadata?: ItemMetadata;
}

export interface SetRunStatusInput {
  runId: string;
  status: string;
  occurredAt?: string;
  metadata?: ItemMetadata;
}

export interface CreateItemInput {
  id?: string;
  runId: string;
  createdAt?: string;
  metadata?: ItemMetadata;
}

export interface AppendEventInput {
  eventId?: string;
  runId: string;
  itemId?: string;
  attemptId?: string;
  type: string;
  occurredAt?: string;
  payload?: unknown;
  /** Compare-and-append guard against the current aggregate version. */
  expectedVersion?: number;
}

export interface AppendItemTransitionInput {
  itemId: string;
  to: ItemStatus;
  eventId?: string;
  occurredAt?: string;
  attemptId?: string;
  reason?: string;
  metadata?: ItemMetadata;
  expectedVersion?: number;
}

export interface ReadEventsQuery {
  runId?: string;
  itemId?: string;
  afterSequence?: number;
  limit?: number;
}

interface EventRow {
  sequence: number;
  event_id: string;
  run_id: string;
  item_id: string | null;
  attempt_id: string | null;
  version: number;
  type: string;
  occurred_at: string;
  payload_json: string;
}

interface RunRow {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

interface ItemRow {
  id: string;
  run_id: string;
  status: ItemStatus;
  attempt: number;
  attempt_id: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

interface AttemptRow {
  id: string;
  run_id: string;
  item_id: string;
  number: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  metadata_json: string;
}

/**
 * Small append-only event log for the v2 engine foundation.
 *
 * `runs`, `items`, and `attempts` are query-friendly current projections.
 * `events` is the durable source of truth: item state is always rebuildable
 * with `rebuildItemState`, and the append-only triggers prevent accidental
 * updates/deletes to the history.
 */
export class SQLiteEventLog {
  readonly databasePath: string;

  private readonly db: SqliteDatabase;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private closed = false;

  constructor(databasePath: string, options: EventLogOptions = {}) {
    this.databasePath = databasePath;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;

    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    // WAL is intentionally configured before schema creation so all writes
    // use the same journaling mode from the first transaction onward.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  /** SQLite reports `wal` for file-backed databases configured correctly. */
  journalMode(): string {
    return String(this.db.pragma("journal_mode", { simple: true })).toLowerCase();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  createRun(input: CreateRunInput = {}): RunRecord {
    this.assertOpen();
    const id = input.id ?? this.idFactory();
    const createdAt = input.createdAt ?? this.now();
    const record: RunRecord = {
      id,
      status: input.status ?? "queued",
      createdAt,
      updatedAt: createdAt,
      metadata: copyMetadata(input.metadata),
    };

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runs (id, status, created_at, updated_at, metadata_json)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.status,
          record.createdAt,
          record.updatedAt,
          stringify(record.metadata)
        );
      this.insertRawEventInTransaction({
        eventId: this.idFactory(),
        runId: record.id,
        type: "run.created",
        occurredAt: createdAt,
        payload: { status: record.status, metadata: record.metadata },
      });
    });
    transaction();
    return record;
  }

  ensureRun(input: CreateRunInput = {}): RunRecord {
    this.assertOpen();
    const id = input.id ?? this.idFactory();
    return this.getRun(id) ?? this.createRun({ ...input, id });
  }

  createItem(input: CreateItemInput): ItemRecord {
    this.assertOpen();
    const id = input.id ?? this.idFactory();
    const createdAt = input.createdAt ?? this.now();
    const record: ItemRecord = {
      id,
      runId: input.runId,
      status: "queued",
      attempt: 0,
      createdAt,
      updatedAt: createdAt,
      metadata: copyMetadata(input.metadata),
    };

    const transaction = this.db.transaction(() => {
      this.requireRunInTransaction(record.runId);
      this.db
        .prepare(
          `INSERT INTO items
             (id, run_id, status, attempt, attempt_id, created_at, updated_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.runId,
          record.status,
          record.attempt,
          null,
          record.createdAt,
          record.updatedAt,
          stringify(record.metadata)
        );
      this.insertRawEventInTransaction({
        eventId: this.idFactory(),
        runId: record.runId,
        itemId: record.id,
        type: "item.created",
        occurredAt: createdAt,
        payload: { metadata: record.metadata },
      });
      this.touchRunInTransaction(record.runId, createdAt);
    });
    transaction();
    return record;
  }

  ensureItem(input: CreateItemInput): ItemRecord {
    this.assertOpen();
    const id = input.id;
    if (id) {
      const existing = this.getItem(id);
      if (existing) return existing;
    }
    return this.createItem(input);
  }

  setRunStatus(input: SetRunStatusInput): RunRecord {
    this.assertOpen();
    const occurredAt = input.occurredAt ?? this.now();
    const transaction = this.db.transaction(() => {
      const current = this.requireRunInTransaction(input.runId);
      const currentMetadata = parseMetadata(current.metadata_json);
      const metadata = {
        ...currentMetadata,
        ...copyMetadata(input.metadata),
      };
      const metadataChanged = JSON.stringify(currentMetadata) !== JSON.stringify(metadata);
      if (
        current.status === input.status &&
        !metadataChanged
      ) {
        return mapRunRow(current);
      }
      this.insertRawEventInTransaction({
        eventId: this.idFactory(),
        runId: input.runId,
        type: "run.status",
        occurredAt,
        payload: { status: input.status, metadata },
      });
      this.db
        .prepare(
          `UPDATE runs SET status = ?, updated_at = ?, metadata_json = ? WHERE id = ?`
        )
        .run(input.status, occurredAt, stringify(metadata), input.runId);
      return mapRunRow(this.requireRunInTransaction(input.runId));
    });
    return transaction();
  }

  /**
   * Append a non-lifecycle event, or a serialized item transition event.
   * Lifecycle callers should prefer `appendItemTransition`, which derives the
   * source state and attempt number from the current projection.
   */
  appendEvent(input: AppendEventInput): StoredEvent {
    this.assertOpen();
    const transaction = this.db.transaction(() =>
      this.appendEventInTransaction(input)
    );
    return transaction();
  }

  appendItemTransition(input: AppendItemTransitionInput): StoredEvent {
    this.assertOpen();
    const transaction = this.db.transaction(() => {
      const row = this.requireItemInTransaction(input.itemId);
      const current = this.rebuildItemStateInTransaction(row.id);
      const currentVersion = this.currentVersionInTransaction(row.id, row.run_id);
      assertExpectedVersion(currentVersion, input.expectedVersion);

      const event = transitionItem(current, input.to, {
        eventId: input.eventId,
        occurredAt: input.occurredAt ?? this.now(),
        attemptId: input.attemptId,
        reason: input.reason,
        metadata: input.metadata,
      });
      return this.appendTransitionEventInTransaction(event, currentVersion);
    });
    return transaction();
  }

  readEvents(query: ReadEventsQuery = {}): StoredEvent[] {
    this.assertOpen();
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (query.runId !== undefined) {
      clauses.push("run_id = ?");
      parameters.push(query.runId);
    }
    if (query.itemId !== undefined) {
      clauses.push("item_id = ?");
      parameters.push(query.itemId);
    }
    if (query.afterSequence !== undefined) {
      clauses.push("sequence > ?");
      parameters.push(query.afterSequence);
    }

    let sql = "SELECT * FROM events";
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY sequence ASC";
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit < 1) {
        throw new Error("readEvents limit must be a positive integer");
      }
      sql += " LIMIT ?";
      parameters.push(query.limit);
    }

    return this.db
      .prepare(sql)
      .all<EventRow>(...parameters)
      .map((row) => mapEventRow(row));
  }

  /** Return only the item lifecycle events understood by the reducer. */
  readItemEvents(itemId: string): ItemEvent[] {
    this.assertOpen();
    return this.readItemEventsInTransaction(itemId);
  }

  /** Rebuild the item state from the event stream, never from the cache row. */
  rebuildItemState(itemId: string): ItemState {
    this.assertOpen();
    return this.rebuildItemStateInTransaction(itemId);
  }

  getRun(id: string): RunRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get<RunRow>(id);
    return row === undefined ? undefined : mapRunRow(row);
  }

  getItem(id: string): ItemRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM items WHERE id = ?")
      .get<ItemRow>(id);
    return row === undefined ? undefined : mapItemRow(row);
  }

  readAttempts(itemId?: string): AttemptRecord[] {
    this.assertOpen();
    if (itemId === undefined) {
      return this.db
        .prepare("SELECT * FROM attempts ORDER BY item_id ASC, number ASC")
        .all<AttemptRow>()
        .map((row) => mapAttemptRow(row));
    }
    return this.db
      .prepare("SELECT * FROM attempts WHERE item_id = ? ORDER BY number ASC")
      .all<AttemptRow>(itemId)
      .map((row) => mapAttemptRow(row));
  }

  private appendEventInTransaction(input: AppendEventInput): StoredEvent {
    if (input.type === "item.created") {
      throw new Error("Use createItem to append item.created");
    }

    if (input.itemId !== undefined) {
      const item = this.requireItemInTransaction(input.itemId);
      if (item.run_id !== input.runId) {
        throw new InvalidItemEventError(
          `Event run ${input.runId} does not match item ${input.itemId} run ${item.run_id}`
        );
      }
      const currentVersion = this.currentVersionInTransaction(input.itemId, input.runId);
      assertExpectedVersion(currentVersion, input.expectedVersion);

      if (input.type === "item.transitioned") {
        const current = this.rebuildItemStateInTransaction(input.itemId);
        const payload = parseTransitionPayload(input.payload);
        const event = transitionEventFromPayload(
          current,
          payload,
          input.eventId ?? this.idFactory(),
          input.occurredAt ?? this.now(),
          input.attemptId,
          input.runId
        );
        return this.appendTransitionEventInTransaction(event, currentVersion);
      }

      if (input.attemptId !== undefined) {
        this.requireAttemptInTransaction(input.attemptId, input.itemId);
      }
    } else {
      this.requireRunInTransaction(input.runId);
    }

    return this.insertRawEventInTransaction(input);
  }

  private appendTransitionEventInTransaction(
    event: ItemEvent & { type: "item.transitioned" },
    expectedVersion: number
  ): StoredEvent {
    const item = this.requireItemInTransaction(event.itemId);
    if (item.run_id !== event.runId) {
      throw new InvalidItemEventError(
        `Event run ${event.runId} does not match item ${event.itemId} run ${item.run_id}`
      );
    }
    const current = this.rebuildItemStateInTransaction(event.itemId);
    // Re-apply before writing so direct serialized events receive exactly the
    // same legal-transition and attempt validation as generated commands.
    reduceItem(current, event);

    if (event.to === "making") {
      if (event.attemptId === undefined) {
        throw new InvalidItemEventError(
          `Maker attempt ${event.attempt} needs an attempt id`
        );
      }
      this.insertAttemptInTransaction({
        id: event.attemptId,
        runId: event.runId,
        itemId: event.itemId,
        number: event.attempt,
        status: event.to,
        startedAt: event.occurredAt,
        metadata: event.metadata,
      });
    }

    const stored = this.insertRawEventInTransaction(
      {
        eventId: event.eventId,
        runId: event.runId,
        itemId: event.itemId,
        attemptId: event.attemptId,
        type: event.type,
        occurredAt: event.occurredAt,
        payload: transitionPayload(event),
        expectedVersion,
      },
      expectedVersion
    );
    const persistedEvent = toItemEvent(stored);
    const next = reduceItem(current, persistedEvent);
    this.updateItemProjectionInTransaction(next);

    if (event.to !== "making") {
      if (event.attemptId !== undefined) {
        this.updateAttemptInTransaction(event.attemptId, event.to, event.occurredAt);
      }
    }
    this.touchRunInTransaction(event.runId, event.occurredAt);
    return stored;
  }

  private insertRawEventInTransaction(
    input: AppendEventInput,
    expectedVersion?: number
  ): StoredEvent {
    this.requireRunInTransaction(input.runId);
    if (input.itemId !== undefined) {
      this.requireItemInTransaction(input.itemId);
      if (input.attemptId !== undefined) {
        this.requireAttemptInTransaction(input.attemptId, input.itemId);
      }
    }
    const currentVersion = this.currentVersionInTransaction(input.itemId, input.runId);
    assertExpectedVersion(currentVersion, input.expectedVersion ?? expectedVersion);
    const version = currentVersion + 1;
    const occurredAt = input.occurredAt ?? this.now();
    const result = this.db
      .prepare(
        `INSERT INTO events
           (event_id, run_id, item_id, attempt_id, version, type, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.eventId ?? this.idFactory(),
        input.runId,
        input.itemId ?? null,
        input.attemptId ?? null,
        version,
        input.type,
        occurredAt,
        stringify(input.payload ?? {})
      );
    const sequence = Number(result.lastInsertRowid);
    const row = this.db
      .prepare("SELECT * FROM events WHERE sequence = ?")
      .get<EventRow>(sequence);
    if (row === undefined) {
      throw new Error(`Inserted event sequence ${sequence} could not be read back`);
    }
    return mapEventRow(row);
  }

  private readItemEventsInTransaction(itemId: string): ItemEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE item_id = ? AND type IN ('item.created', 'item.transitioned')
         ORDER BY sequence ASC`
      )
      .all<EventRow>(itemId);
    return rows.map((row) => toItemEvent(mapEventRow(row)));
  }

  private rebuildItemStateInTransaction(itemId: string): ItemState {
    this.requireItemInTransaction(itemId);
    return projectItem(this.readItemEventsInTransaction(itemId));
  }

  private currentVersionInTransaction(itemId: string | undefined, runId: string): number {
    const row = itemId === undefined
      ? this.db
          .prepare(
            `SELECT COALESCE(MAX(version), 0) AS version
             FROM events WHERE run_id = ? AND item_id IS NULL`
          )
          .get<{ version: number }>(runId)
      : this.db
          .prepare(
            `SELECT COALESCE(MAX(version), 0) AS version
             FROM events WHERE item_id = ?`
          )
      .get<{ version: number }>(itemId);
    return row?.version ?? 0;
  }

  private requireRunInTransaction(id: string): RunRow {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get<RunRow>(id);
    if (row === undefined) throw new Error(`Run ${id} does not exist`);
    return row;
  }

  private requireItemInTransaction(id: string): ItemRow {
    const row = this.db
      .prepare("SELECT * FROM items WHERE id = ?")
      .get<ItemRow>(id);
    if (row === undefined) throw new Error(`Item ${id} does not exist`);
    return row;
  }

  private requireAttemptInTransaction(id: string, itemId: string): AttemptRow {
    const row = this.db
      .prepare("SELECT * FROM attempts WHERE id = ? AND item_id = ?")
      .get<AttemptRow>(id, itemId);
    if (row === undefined) {
      throw new Error(`Attempt ${id} does not belong to item ${itemId}`);
    }
    return row;
  }

  private insertAttemptInTransaction(input: {
    id: string;
    runId: string;
    itemId: string;
    number: number;
    status: string;
    startedAt: string;
    metadata?: ItemMetadata;
  }): void {
    this.db
      .prepare(
        `INSERT INTO attempts
           (id, run_id, item_id, number, status, started_at, finished_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.runId,
        input.itemId,
        input.number,
        input.status,
        input.startedAt,
        null,
        stringify(input.metadata ?? {})
      );
  }

  private updateAttemptInTransaction(
    id: string,
    status: ItemStatus,
    occurredAt: string
  ): void {
    const finishedAt = ATTEMPT_FINISH_STATUSES.has(status) ? occurredAt : null;
    const result = this.db
      .prepare(
        `UPDATE attempts
         SET status = ?, finished_at = COALESCE(?, finished_at)
         WHERE id = ?`
      )
      .run(status, finishedAt, id);
    if (result.changes !== 1) {
      throw new InvalidItemEventError(`Attempt ${id} could not be updated`);
    }
  }

  private updateItemProjectionInTransaction(state: ItemState): void {
    const result = this.db
      .prepare(
        `UPDATE items
         SET status = ?, attempt = ?, attempt_id = ?, updated_at = ?, metadata_json = ?
         WHERE id = ?`
      )
      .run(
        state.status,
        state.attempt,
        state.attemptId ?? null,
        state.updatedAt,
        stringify(state.metadata),
        state.itemId
      );
    if (result.changes !== 1) {
      throw new InvalidItemEventError(`Item ${state.itemId} could not be projected`);
    }
  }

  private touchRunInTransaction(runId: string, updatedAt: string): void {
    this.db
      .prepare("UPDATE runs SET updated_at = ? WHERE id = ?")
      .run(updatedAt, runId);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite event log is closed");
  }
}

export const EventLog = SQLiteEventLog;

export function openEventLog(
  databasePath: string,
  options?: EventLogOptions
): SQLiteEventLog {
  return new SQLiteEventLog(databasePath, options);
}

function transitionPayload(event: ItemEvent & { type: "item.transitioned" }): Record<string, unknown> {
  return {
    from: event.from,
    to: event.to,
    attempt: event.attempt,
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
  };
}

function transitionEventFromPayload(
  current: ItemState,
  payload: TransitionPayload,
  eventId: string,
  occurredAt: string,
  inputAttemptId: string | undefined,
  runId: string,
  version?: number
): ItemEvent & { type: "item.transitioned" } {
  const attemptId =
    payload.to === "making"
      ? inputAttemptId ?? payload.attemptId ?? randomUUID()
      : inputAttemptId ?? payload.attemptId ?? current.attemptId;
  const event: ItemEvent & { type: "item.transitioned" } = {
    type: "item.transitioned",
    eventId,
    itemId: current.itemId,
    runId,
    occurredAt,
    from: payload.from,
    to: payload.to,
    attempt: payload.attempt ?? (payload.to === "making" ? current.attempt + 1 : current.attempt),
    ...(version === undefined ? {} : { version }),
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
  };
  return event;
}

interface TransitionPayload {
  from: ItemStatus;
  to: ItemStatus;
  attempt?: number;
  attemptId?: string;
  reason?: string;
  metadata?: ItemMetadata;
}

function parseTransitionPayload(payload: unknown): TransitionPayload {
  if (!isRecord(payload)) {
    throw new InvalidItemEventError("item.transitioned payload must be an object");
  }
  const from = asItemStatus(payload.from, "from");
  const to = asItemStatus(payload.to, "to");
  if (payload.attempt !== undefined && typeof payload.attempt !== "number") {
    throw new InvalidItemEventError("item.transitioned attempt must be a number");
  }
  if (payload.attemptId !== undefined && typeof payload.attemptId !== "string") {
    throw new InvalidItemEventError("item.transitioned attemptId must be a string");
  }
  if (payload.reason !== undefined && typeof payload.reason !== "string") {
    throw new InvalidItemEventError("item.transitioned reason must be a string");
  }
  return {
    from,
    to,
    attempt: payload.attempt as number | undefined,
    attemptId: payload.attemptId as string | undefined,
    reason: payload.reason as string | undefined,
    metadata: copyMetadata(payload.metadata),
  };
}

function asItemStatus(value: unknown, field: string): ItemStatus {
  if (
    typeof value !== "string" ||
    !(ITEM_STATUSES as readonly string[]).includes(value)
  ) {
    throw new InvalidItemEventError(`item.transitioned ${field} is not a valid item status`);
  }
  return value as ItemStatus;
}

function toItemEvent(event: StoredEvent): ItemEvent {
  if (event.itemId === undefined) {
    throw new InvalidItemEventError(`Event ${event.eventId} has no item id`);
  }
  if (event.type === "item.created") {
    const payload = isRecord(event.payload) ? event.payload : {};
    return createItemCreatedEvent({
      eventId: event.eventId,
      itemId: event.itemId,
      runId: event.runId,
      occurredAt: event.occurredAt,
      version: event.version,
      metadata: copyMetadata(payload.metadata),
    });
  }
  if (event.type === "item.transitioned") {
    const payload = parseTransitionPayload(event.payload);
    return transitionEventFromPayload(
      {
        itemId: event.itemId,
        runId: event.runId,
        status: payload.from,
        attempt: payload.attempt ?? 0,
        attemptId: payload.attemptId,
        version: Math.max(0, event.version - 1),
        metadata: {},
        updatedAt: event.occurredAt,
      },
      payload,
      event.eventId,
      event.occurredAt,
      event.attemptId,
      event.runId,
      event.version
    ) satisfies ItemEvent;
  }
  throw new InvalidItemEventError(`Event ${event.eventId} is not an item lifecycle event`);
}

function mapEventRow(row: EventRow): StoredEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    runId: row.run_id,
    ...(row.item_id === null ? {} : { itemId: row.item_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    version: row.version,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: parseJson(row.payload_json),
  };
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseMetadata(row.metadata_json),
  };
}

function mapItemRow(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    attempt: row.attempt,
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseMetadata(row.metadata_json),
  };
}

function mapAttemptRow(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    itemId: row.item_id,
    number: row.number,
    status: row.status,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    metadata: parseMetadata(row.metadata_json),
  };
}

function assertExpectedVersion(current: number, expected: number | undefined): void {
  if (expected !== undefined && current !== expected) {
    throw new Error(`Expected item version ${expected}, current version is ${current}`);
  }
}

function copyMetadata(value: unknown): ItemMetadata {
  if (!isRecord(value)) return {};
  return { ...value };
}

function parseMetadata(value: string): ItemMetadata {
  return copyMetadata(parseJson(value));
}

function stringify(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) return "null";
  return result;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON in event log: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
