import { hostname } from "node:os";
import { describe, expect, it } from "vitest";

import { createRunOwnerRecord, isRecordedRunOwnerActive } from "../../src/artifacts/owner.js";

describe("run owner records", () => {
  it("reports invalid owner records as indeterminate", async () => {
    await expect(isRecordedRunOwnerActive({})).resolves.toBeUndefined();
    await expect(isRecordedRunOwnerActive({ owner_pid: -1 })).resolves.toBeUndefined();
  });

  it("reports foreign-host owners as inactive without probing the process", async () => {
    await expect(
      isRecordedRunOwnerActive({
        owner_pid: process.pid,
        owner_hostname: `not-${hostname()}`
      })
    ).resolves.toBe(false);
  });

  it("recognizes the current process owner record as active", async () => {
    const owner = await createRunOwnerRecord(process.pid);

    await expect(isRecordedRunOwnerActive(owner)).resolves.toBe(true);
  });

  it("recognizes a reachable process without a start fingerprint as active", async () => {
    await expect(
      isRecordedRunOwnerActive({
        owner_pid: process.pid,
        owner_hostname: hostname()
      })
    ).resolves.toBe(true);
  });

  it("reports an unreachable local process as inactive", async () => {
    await expect(
      isRecordedRunOwnerActive({
        owner_pid: 999_999_999,
        owner_hostname: hostname()
      })
    ).resolves.toBe(false);
  });

  it("treats a live pid with mismatched start time as inactive", async () => {
    const owner = await createRunOwnerRecord(process.pid);

    await expect(
      isRecordedRunOwnerActive({
        ...owner,
        owner_started_at: `${owner.owner_started_at ?? "unknown-start"} mismatch`
      })
    ).resolves.toBe(false);
  });

  it("creates owner records without a start fingerprint for invalid pids", async () => {
    await expect(createRunOwnerRecord(-1)).resolves.toMatchObject({
      owner_pid: -1,
      owner_hostname: hostname()
    });
  });
});
