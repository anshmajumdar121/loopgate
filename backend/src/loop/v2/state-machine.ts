import { randomUUID } from "node:crypto";

/**
 * The Phase A item lifecycle. The transition table below is the source of
 * truth for legal movement; reducers never infer or skip phases.
 */
export const ITEM_STATUSES = [
  "queued",
  "planning",
  "making",
  "checking",
  "verifying",
  "approved",
  "rejected",
  "escalated",
  "cancelled",
  "failed",
] as const;

export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemMetadata = Record<string, unknown>;

export const ITEM_TRANSITIONS: Readonly<{
  [Status in ItemStatus]: readonly ItemStatus[];
}> = {
  queued: ["planning", "cancelled", "failed"],
  planning: ["making", "cancelled", "failed"],
  making: ["checking", "cancelled", "failed"],
  checking: ["verifying", "cancelled", "failed"],
  verifying: ["approved", "rejected", "escalated", "cancelled", "failed"],
  approved: [],
  rejected: ["making"],
  escalated: [],
  cancelled: [],
  failed: [],
};

export interface ItemState {
  itemId: string;
  runId: string;
  status: ItemStatus;
  /** Number of maker attempts. The first entry into `making` is attempt 1. */
  attempt: number;
  /** Attempt aggregate currently associated with this item, when one exists. */
  attemptId?: string;
  /** Last item-event version used to build this state. */
  version: number;
  reason?: string;
  metadata: ItemMetadata;
  updatedAt: string;
}

interface BaseItemEvent {
  eventId: string;
  itemId: string;
  runId: string;
  occurredAt: string;
  /** Database aggregate version, populated when replaying persisted events. */
  version?: number;
}

export interface ItemCreatedEvent extends BaseItemEvent {
  type: "item.created";
  metadata?: ItemMetadata;
}

export interface ItemTransitionedEvent extends BaseItemEvent {
  type: "item.transitioned";
  from: ItemStatus;
  to: ItemStatus;
  attempt: number;
  attemptId?: string;
  reason?: string;
  metadata?: ItemMetadata;
}

export type ItemEvent = ItemCreatedEvent | ItemTransitionedEvent;

export interface CreateItemCreatedEventInput {
  eventId: string;
  itemId: string;
  runId: string;
  occurredAt: string;
  metadata?: ItemMetadata;
  version?: number;
}

export interface TransitionOptions {
  eventId?: string;
  occurredAt?: string;
  attemptId?: string;
  reason?: string;
  metadata?: ItemMetadata;
}

export class InvalidItemTransitionError extends Error {
  readonly from: ItemStatus;
  readonly to: ItemStatus;

  constructor(from: ItemStatus, to: ItemStatus) {
    super(`Illegal item transition: ${from} -> ${to}`);
    this.name = "InvalidItemTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class InvalidItemEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidItemEventError";
  }
}

export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  return (ITEM_TRANSITIONS[from] as readonly ItemStatus[]).includes(to);
}

export function isTerminalStatus(status: ItemStatus): boolean {
  return ITEM_TRANSITIONS[status].length === 0;
}

export function createItemCreatedEvent(
  input: CreateItemCreatedEventInput
): ItemCreatedEvent {
  return {
    type: "item.created",
    eventId: input.eventId,
    itemId: input.itemId,
    runId: input.runId,
    occurredAt: input.occurredAt,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
  };
}

/**
 * Build a transition event without changing the supplied state. This makes
 * command creation explicit while keeping the projection/reducer pure.
 */
export function transitionItem(
  state: ItemState,
  to: ItemStatus,
  options: TransitionOptions = {}
): ItemTransitionedEvent {
  if (!canTransition(state.status, to)) {
    throw new InvalidItemTransitionError(state.status, to);
  }

  const attempt = to === "making" ? state.attempt + 1 : state.attempt;
  const attemptId =
    to === "making"
      ? options.attemptId ?? randomUUID()
      : options.attemptId ?? state.attemptId;

  return {
    type: "item.transitioned",
    eventId: options.eventId ?? randomUUID(),
    itemId: state.itemId,
    runId: state.runId,
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    from: state.status,
    to,
    attempt,
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
  };
}

/**
 * Apply one event to an item state. No mutation occurs; malformed or stale
 * events fail closed so a bad log cannot silently produce an invalid state.
 */
export function reduceItem(
  state: ItemState | undefined,
  event: ItemEvent
): ItemState {
  if (event.type === "item.created") {
    if (state !== undefined) {
      throw new InvalidItemEventError(
        `Item ${event.itemId} was created more than once`
      );
    }
    return {
      itemId: event.itemId,
      runId: event.runId,
      status: "queued",
      attempt: 0,
      version: event.version ?? 1,
      metadata: { ...(event.metadata ?? {}) },
      updatedAt: event.occurredAt,
    };
  }

  if (state === undefined) {
    throw new InvalidItemEventError(
      `Cannot apply ${event.type} before item ${event.itemId} is created`
    );
  }
  if (state.itemId !== event.itemId || state.runId !== event.runId) {
    throw new InvalidItemEventError(
      `Event ${event.eventId} does not belong to item ${state.itemId} in run ${state.runId}`
    );
  }
  if (state.status !== event.from) {
    throw new InvalidItemEventError(
      `Event ${event.eventId} has source state ${event.from}, but item ${state.itemId} is ${state.status}`
    );
  }
  if (!canTransition(event.from, event.to)) {
    throw new InvalidItemTransitionError(event.from, event.to);
  }

  const expectedAttempt =
    event.to === "making" ? state.attempt + 1 : state.attempt;
  if (event.attempt !== expectedAttempt) {
    throw new InvalidItemEventError(
      `Event ${event.eventId} has attempt ${event.attempt}, expected ${expectedAttempt}`
    );
  }

  return {
    ...state,
    status: event.to,
    attempt: event.attempt,
    attemptId: event.attemptId ?? state.attemptId,
    version: event.version ?? state.version + 1,
    reason: event.reason,
    metadata: {
      ...state.metadata,
      ...(event.metadata ?? {}),
    },
    updatedAt: event.occurredAt,
  };
}

/** Rebuild an item state by applying its events in persisted order. */
export function projectItem(events: readonly ItemEvent[]): ItemState {
  if (events.length === 0) {
    throw new InvalidItemEventError("Cannot project an item from zero events");
  }

  let state: ItemState | undefined;
  for (const event of events) {
    state = reduceItem(state, event);
  }
  if (state === undefined) {
    throw new InvalidItemEventError("Cannot project an item from zero events");
  }
  return state;
}
