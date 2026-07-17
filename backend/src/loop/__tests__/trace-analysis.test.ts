import { describe, it, expect } from "vitest";
import {
  detectRepeatedRejections,
  detectCriteriaMisses,
  detectValidationRegressions,
  detectStallClusters,
  detectNoOpAttempts,
  analyzePatterns,
} from "../trace-analysis.js";
import type { Task, Verdict, CriteriaWalkItem } from "../../types.js";

function mkTask(id: string, reason: string | null): Task {
  const verdict: Verdict | undefined = reason
    ? ({
        attempt: 1,
        outcome: "REJECT",
        buildExit: 0,
        testsPassed: 0,
        testsFailed: 0,
        scopePass: true,
        intentPass: false,
        noCheatingPass: true,
        risk: "LOW",
        criteriaWalk: [],
        requiredFixes: [],
        oneLineReason: reason,
      } as Verdict)
    : undefined;
  return {
    id,
    title: id,
    prompt: "x",
    workdir: "/tmp",
    status: "done",
    attempt: 1,
    maxAttempts: 3,
    createdAt: "2026-07-16T00:00:00Z",
    updatedAt: "2026-07-16T00:00:00Z",
    history: [],
    logs: [],
    verdict,
    attempts: [
      { attemptNumber: 1, verifierVerdict: "REJECT" },
    ],
  };
}

describe("detectRepeatedRejections", () => {
  it("returns [] when no tasks have REJECT verdicts", () => {
    expect(
      detectRepeatedRejections([
        mkTask("a", null),
        { ...mkTask("b", null), verdict: { ...mkTask("b", null).verdict!, outcome: "APPROVE" } },
      ])
    ).toEqual([]);
  });

  it("returns [] when each rejection is unique (no repeat)", () => {
    const tasks = [
      mkTask("a", "missing some criteria"),
      mkTask("b", "tests failed"),
      mkTask("c", "build error"),
    ];
    expect(detectRepeatedRejections(tasks)).toEqual([]);
  });

  it("groups rejections with the same lowercase substring", () => {
    const tasks = [
      mkTask("a", "Missing criteria — list is empty"),
      mkTask("b", "missing criteria! 5 expected"),
      mkTask("c", "totally different complaint"),
    ];
    const findings = detectRepeatedRejections(tasks);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("repeated-reject");
    expect(findings[0].count).toBe(2);
    expect(findings[0].pattern).toContain("missing criteria");
    expect(findings[0].suggestedFix).toBe("prompt");
  });

  it("sorts by count desc, capped at 10", () => {
    const tasks: Task[] = [];
    for (let i = 0; i < 5; i++) tasks.push(mkTask(`r-${i}`, "criteria missing"));
    for (let i = 0; i < 3; i++) tasks.push(mkTask(`t-${i}`, "tests broken"));
    for (let i = 0; i < 7; i++) tasks.push(mkTask(`b-${i}`, "build step failed"));
    const findings = detectRepeatedRejections(tasks);
    expect(findings).toHaveLength(3);
    expect(findings[0].count).toBe(7);
    expect(findings[1].count).toBe(5);
    expect(findings[2].count).toBe(3);
  });

  it("ignores very short reject keys (noise like 'no' / 'fail')", () => {
    const tasks = [
      mkTask("a", "no"),
      mkTask("b", "no"),
      mkTask("c", "no"),
    ];
    expect(detectRepeatedRejections(tasks)).toEqual([]);
  });

  it("tags role as 'verifier' when attempts record a REJECT verdict", () => {
    const tasks = [
      mkTask("a", "criteria missing from plan"),
      mkTask("b", "criteria missing from plan"),
    ];
    const findings = detectRepeatedRejections(tasks);
    expect(findings[0].role).toBe("verifier");
  });

  it("examples list is capped at 5 per pattern", () => {
    const tasks: Task[] = [];
    for (let i = 0; i < 12; i++) tasks.push(mkTask(`t-${i}`, "criteria missing"));
    const findings = detectRepeatedRejections(tasks);
    expect(findings[0].count).toBe(12);
    expect(findings[0].examples).toHaveLength(5);
  });
});

describe("analyzePatterns", () => {
  it("is the public entry point and returns detector output", async () => {
    const tasks = [
      mkTask("a", "criteria missing"),
      mkTask("b", "criteria missing"),
    ];
    const findings = await analyzePatterns(tasks);
    expect(findings).toHaveLength(1);
    expect(findings[0].pattern).toContain("criteria missing");
  });
});

function mkVerdictWithCriteria(
  id: string,
  criteria: Array<[string, boolean, string]>
): Task {
  const v: Verdict = {
    attempt: 1,
    outcome: "REJECT",
    buildExit: 0,
    testsPassed: 0,
    testsFailed: 0,
    scopePass: true,
    intentPass: false,
    noCheatingPass: true,
    risk: "LOW",
    criteriaWalk: criteria.map(
      ([criterion, passed, evidence]): CriteriaWalkItem => ({
        criterion,
        passed,
        evidence,
      })
    ),
    requiredFixes: [],
    oneLineReason: "criteria issue",
  } as Verdict;
  return { ...mkTask(id, "x"), verdict: v };
}

describe("detectCriteriaMisses", () => {
  it("returns [] when no criterion fails in 3+ tasks", () => {
    const tasks = [
      mkVerdictWithCriteria("a", [["build a button", true, "ok"]]),
      mkVerdictWithCriteria("b", [["build a button", true, "ok"]]),
    ];
    expect(detectCriteriaMisses(tasks)).toEqual([]);
  });

  it("flags a criterion that fails in 3+ different tasks", () => {
    const tasks = [
      mkVerdictWithCriteria("a", [["button has color", false, "missing"]]),
      mkVerdictWithCriteria("b", [["button has color", false, "missing"]]),
      mkVerdictWithCriteria("c", [["button has color", false, "missing"]]),
    ];
    const findings = detectCriteriaMisses(tasks);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("criteria-miss");
    expect(findings[0].pattern).toBe("button has color");
    expect(findings[0].count).toBe(3);
  });

  it("ignores criteria that are passed", () => {
    const tasks = [
      mkVerdictWithCriteria("a", [["build a button", true, "ok"]]),
      mkVerdictWithCriteria("b", [["build a button", true, "ok"]]),
      mkVerdictWithCriteria("c", [["build a button", true, "ok"]]),
    ];
    expect(detectCriteriaMisses(tasks)).toEqual([]);
  });
});

function mkTaskWithAttempts(
  id: string,
  attempts: NonNullable<Task["attempts"]>
): Task {
  return {
    ...mkTask(id, null),
    attempts,
  };
}

describe("detectValidationRegressions", () => {
  it("returns [] when no validation flip occurs", () => {
    const tasks = [
      mkTaskWithAttempts("a", [
        { attemptNumber: 1, validation: { passed: true, errors: [] } },
        { attemptNumber: 2, validation: { passed: true, errors: [] } },
      ]),
    ];
    expect(detectValidationRegressions(tasks)).toEqual([]);
  });

  it("flags a passed → failed validation flip", () => {
    const tasks = [
      mkTaskWithAttempts("a", [
        { attemptNumber: 1, validation: { passed: true, errors: [] } },
        {
          attemptNumber: 2,
          validation: { passed: false, errors: ["syntax error"] },
        },
      ]),
    ];
    const findings = detectValidationRegressions(tasks);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("validation-regression");
    expect(findings[0].role).toBe("maker");
  });

  it("does not flag passed → passed (no flip)", () => {
    const tasks = [
      mkTaskWithAttempts("a", [
        { attemptNumber: 1, validation: { passed: true, errors: [] } },
        { attemptNumber: 2, validation: { passed: true, errors: [] } },
      ]),
    ];
    expect(detectValidationRegressions(tasks)).toEqual([]);
  });
});

describe("detectStallClusters", () => {
  it("returns [] when no task has stalls", () => {
    const tasks = [mkTaskWithAttempts("a", [{ attemptNumber: 1 }])];
    expect(detectStallClusters(tasks)).toEqual([]);
  });

  it("flags 2+ stalls in the same role", () => {
    const tasks = [
      mkTaskWithAttempts("a", [
        {
          attemptNumber: 1,
          stalls: [
            {
              phase: "maker",
              stalledAfterMs: 240_000,
              resolution: "reinvoke",
            },
          ],
        },
      ]),
      mkTaskWithAttempts("b", [
        {
          attemptNumber: 1,
          stalls: [
            {
              phase: "maker",
              stalledAfterMs: 240_000,
              resolution: "escalated",
            },
          ],
        },
      ]),
    ];
    const findings = detectStallClusters(tasks);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("stall-cluster");
    expect(findings[0].role).toBe("maker");
    expect(findings[0].count).toBe(2);
  });

  it("does not cluster stalls across different roles", () => {
    const tasks = [
      mkTaskWithAttempts("a", [
        {
          attemptNumber: 1,
          stalls: [
            {
              phase: "maker",
              stalledAfterMs: 240_000,
              resolution: "reinvoke",
            },
          ],
        },
      ]),
      mkTaskWithAttempts("b", [
        {
          attemptNumber: 1,
          stalls: [
            {
              phase: "verifier",
              stalledAfterMs: 240_000,
              resolution: "reinvoke",
            },
          ],
        },
      ]),
    ];
    expect(detectStallClusters(tasks)).toEqual([]);
  });
});

describe("detectNoOpAttempts", () => {
  it("returns [] when no consecutive attempts touch the same files", () => {
    const tasks = [
      mkTaskWithAttempts("a", [
        {
          attemptNumber: 1,
          filesChanged: [{ path: "a.ts", reason: "x" }],
        },
        {
          attemptNumber: 2,
          filesChanged: [{ path: "b.ts", reason: "x" }],
        },
      ]),
    ];
    expect(detectNoOpAttempts(tasks)).toEqual([]);
  });

  it("flags consecutive attempts that rewrite the same file set", () => {
    const tasks = [
      mkTaskWithAttempts("a", [
        {
          attemptNumber: 1,
          filesChanged: [
            { path: "a.ts", reason: "x" },
            { path: "b.ts", reason: "y" },
          ],
        },
        {
          attemptNumber: 2,
          filesChanged: [
            { path: "a.ts", reason: "x" },
            { path: "b.ts", reason: "y" },
          ],
        },
      ]),
    ];
    const findings = detectNoOpAttempts(tasks);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("no-op-attempts");
    expect(findings[0].role).toBe("maker");
  });
});
