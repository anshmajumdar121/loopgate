import { describe, it, expect } from "vitest";
import type { WsServerMessage } from "../types.js";

describe("WsServerMessage", () => {
  it("includes task_re_prompted variant", () => {
    const msg: WsServerMessage = {
      type: "task_re_prompted",
      taskId: "t1",
      prompt: "new prompt",
      attempt: 2,
    };
    expect(msg.type).toBe("task_re_prompted");
    expect(msg.attempt).toBe(2);
  });

  it("includes task_deleted variant", () => {
    const msg: WsServerMessage = {
      type: "task_deleted",
      taskId: "t1",
    };
    expect(msg.type).toBe("task_deleted");
  });
});