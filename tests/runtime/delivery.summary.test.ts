import { describe, expect, it } from "vitest";

import { selectPrimaryRunDiagnostic } from "../../src/runtime/delivery/summary.js";
import type { RuntimeNodeAttempt } from "../../src/runtime/attempts.js";
import type { RuntimeEventEnvelope } from "../../src/runtime/events.js";
import type { RuntimeStateSnapshot } from "../../src/runtime/session.js";

function attemptWithError(error: string): RuntimeNodeAttempt {
  return {
    execution_id: "exec-1",
    compiled_id: "compiled-1",
    authored_id: "work_list_items",
    kind: "agent",
    repo_alias: "main",
    execution_dir: "/tmp/exec-1",
    attempt_index: 1,
    status: "failed",
    outcome: "failed",
    started_at: "2026-01-01T00:00:00.000Z",
    artifacts: {},
    metadata: { error }
  };
}

function deliveryFailedEvent(): RuntimeEventEnvelope {
  return {
    seq: 10,
    ts: "2026-01-01T00:00:10.000Z",
    run_id: "run-1",
    type: "delivery.curation.failed",
    payload: {
      reason: "Delivery curation failed verification."
    }
  };
}

describe("run delivery diagnostics", () => {
  it("keeps the node failure as primary when delivery curation also fails", () => {
    const diagnostic = selectPrimaryRunDiagnostic(
      [attemptWithError("Declared artifact \"item_handoffs\" is empty.")],
      [deliveryFailedEvent()],
      { status: "failed" } as RuntimeStateSnapshot
    );

    expect(diagnostic).toEqual({
      label: "work_list_items",
      summary: "Declared artifact \"item_handoffs\" is empty."
    });
  });
});
