import { describe, expect, it } from "vitest";
import { isDefenceDisabled } from "../defence-flags.js";

describe("defence mutation flags", () => {
  it("ignores the disable flag unless mock mode is explicitly enabled", () => {
    expect(
      isDefenceDisabled("skip-added", { LOOP_TEST_DISABLE_DEFENCE: "skip-added" }),
    ).toBe(false);
    expect(
      isDefenceDisabled("skip-added", {
        LOOP_ALLOW_MOCK: "0",
        LOOP_TEST_DISABLE_DEFENCE: "skip-added",
      }),
    ).toBe(false);
    expect(
      isDefenceDisabled("skip-added", {
        LOOP_ALLOW_MOCK: "1",
        LOOP_TEST_DISABLE_DEFENCE: "skip-added",
      }),
    ).toBe(true);
    expect(
      isDefenceDisabled("trivial-assertion", {
        LOOP_ALLOW_MOCK: "1",
        LOOP_TEST_DISABLE_DEFENCE: "skip-added",
      }),
    ).toBe(false);
  });
});
