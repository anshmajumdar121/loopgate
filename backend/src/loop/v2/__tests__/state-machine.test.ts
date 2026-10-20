import { describe, expect, it } from "vitest";
import {
  ITEM_TRANSITIONS,
  InvalidItemTransitionError,
  canTransition,
  createItemCreatedEvent,
  projectItem,
  reduceItem,
  transitionItem,
  type ItemEvent,
} from "../state-machine.js";

const created = createItemCreatedEvent({
  eventId: "event-1",
  itemId: "item-1",
  runId: "run-1",
  occurredAt: "2026-10-20T00:00:00.000Z",
});

function transition(
  state: ReturnType<typeof projectItem>,
  to: Parameters<typeof transitionItem>[1],
  eventId: string,
  occurredAt: string
): ItemEvent {
  return transitionItem(state, to, {
    eventId,
    occurredAt,
    attemptId: to === "making" ? `${eventId}-attempt` : undefined,
  });
}

describe("item state machine", () => {
  it("projects the documented happy path from an event sequence", () => {
    const planning = transition(
      projectItem([created]),
      "planning",
      "event-2",
      "2026-10-20T00:00:01.000Z"
    );
    const making = transition(
      projectItem([created, planning]),
      "making",
      "event-3",
      "2026-10-20T00:00:02.000Z"
    );
    const checking = transition(
      projectItem([created, planning, making]),
      "checking",
      "event-4",
      "2026-10-20T00:00:03.000Z"
    );
    const verifying = transition(
      projectItem([created, planning, making, checking]),
      "verifying",
      "event-5",
      "2026-10-20T00:00:04.000Z"
    );
    const approved = transition(
      projectItem([created, planning, making, checking, verifying]),
      "approved",
      "event-6",
      "2026-10-20T00:00:05.000Z"
    );

    expect(projectItem([created, planning, making, checking, verifying, approved])).toMatchObject({
      itemId: "item-1",
      runId: "run-1",
      status: "approved",
      attempt: 1,
      attemptId: "event-3-attempt",
      version: 6,
      updatedAt: "2026-10-20T00:00:05.000Z",
    });
  });

  it("supports rejection -> making retries and increments the attempt", () => {
    const planning = transition(
      projectItem([created]),
      "planning",
      "event-2",
      "2026-10-20T00:00:01.000Z"
    );
    const firstMaking = transition(
      projectItem([created, planning]),
      "making",
      "event-3",
      "2026-10-20T00:00:02.000Z"
    );
    const checking = transition(
      projectItem([created, planning, firstMaking]),
      "checking",
      "event-4",
      "2026-10-20T00:00:03.000Z"
    );
    const verifying = transition(
      projectItem([created, planning, firstMaking, checking]),
      "verifying",
      "event-5",
      "2026-10-20T00:00:04.000Z"
    );
    const rejected = transition(
      projectItem([created, planning, firstMaking, checking, verifying]),
      "rejected",
      "event-6",
      "2026-10-20T00:00:05.000Z"
    );
    const secondMaking = transition(
      projectItem([created, planning, firstMaking, checking, verifying, rejected]),
      "making",
      "event-7",
      "2026-10-20T00:00:06.000Z"
    );

    expect(secondMaking).toMatchObject({
      type: "item.transitioned",
      from: "rejected",
      to: "making",
      attempt: 2,
      attemptId: "event-7-attempt",
    });
    expect(
      projectItem([
        created,
        planning,
        firstMaking,
        checking,
        verifying,
        rejected,
        secondMaking,
      ])
    ).toMatchObject({ status: "making", attempt: 2, attemptId: "event-7-attempt" });
  });

  it("enforces every legal edge in the lifecycle table", () => {
    for (const [from, targets] of Object.entries(ITEM_TRANSITIONS)) {
      for (const to of targets) {
        expect(canTransition(from as keyof typeof ITEM_TRANSITIONS, to)).toBe(true);
      }
    }

    expect(canTransition("queued", "checking")).toBe(false);
    expect(canTransition("approved", "making")).toBe(false);
    expect(canTransition("escalated", "planning")).toBe(false);
    expect(canTransition("cancelled", "planning")).toBe(false);
    expect(canTransition("failed", "planning")).toBe(false);
  });

  it.each(["approved", "rejected", "escalated", "cancelled", "failed"] as const)(
    "projects the verifying -> %s branch",
    (terminalStatus) => {
      const planning = transition(
        projectItem([created]),
        "planning",
        "branch-2",
        "2026-10-20T00:00:01.000Z"
      );
      const making = transition(
        projectItem([created, planning]),
        "making",
        "branch-3",
        "2026-10-20T00:00:02.000Z"
      );
      const checking = transition(
        projectItem([created, planning, making]),
        "checking",
        "branch-4",
        "2026-10-20T00:00:03.000Z"
      );
      const verifying = transition(
        projectItem([created, planning, making, checking]),
        "verifying",
        "branch-5",
        "2026-10-20T00:00:04.000Z"
      );
      const terminal = transition(
        projectItem([created, planning, making, checking, verifying]),
        terminalStatus,
        "branch-6",
        "2026-10-20T00:00:05.000Z"
      );

      expect(projectItem([created, planning, making, checking, verifying, terminal])).toMatchObject({
        status: terminalStatus,
        attempt: 1,
      });
      if (terminalStatus !== "rejected") {
        expect(() =>
          transition(
            projectItem([created, planning, making, checking, verifying, terminal]),
            "making",
            "branch-illegal",
            "2026-10-20T00:00:06.000Z"
          )
        ).toThrow(InvalidItemTransitionError);
      }
    }
  );

  it("rejects an illegal transition while leaving the prior state unchanged", () => {
    const state = projectItem([created]);
    const invalidEvent = {
      eventId: "event-invalid",
      type: "item.transitioned" as const,
      itemId: "item-1",
      runId: "run-1",
      occurredAt: "2026-10-20T00:00:01.000Z",
      from: "queued" as const,
      to: "verifying" as const,
      attempt: 0,
    };

    expect(() => reduceItem(state, invalidEvent)).toThrow(InvalidItemTransitionError);
    expect(state).toMatchObject({ status: "queued", attempt: 0, version: 1 });
  });

  it("rejects a stale event whose source does not match the projected state", () => {
    const state = projectItem([
      created,
      transition(projectItem([created]), "planning", "event-2", "2026-10-20T00:00:01.000Z"),
    ]);
    const staleEvent = {
      eventId: "event-stale",
      type: "item.transitioned" as const,
      itemId: "item-1",
      runId: "run-1",
      occurredAt: "2026-10-20T00:00:02.000Z",
      from: "queued" as const,
      to: "planning" as const,
      attempt: 0,
    };

    expect(() => reduceItem(state, staleEvent)).toThrow(/source state/i);
  });
});
