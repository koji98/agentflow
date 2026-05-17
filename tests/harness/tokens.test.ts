import { describe, expect, it } from "vitest";

import { substituteAgentflowTokens } from "../../src/runtime/harness/tokens.js";

describe("substituteAgentflowTokens", () => {
  const tokens = {
    AGENTFLOW_WORKSPACE: "/abs/repo",
    AGENTFLOW_OUTPUT_DIR: "/abs/runs/exec/artifacts",
    AGENTFLOW_CONTEXT_PACKET: "/abs/runs/exec/runtime/context.json",
    AGENTFLOW_CONTEXT_MANIFEST: "/abs/runs/exec/agent/context.md",
    AGENTFLOW_CONTEXT_SPEC: "/abs/repo/spec.md"
  };

  it("substitutes the ${NAME} braced form", () => {
    const result = substituteAgentflowTokens(
      "Save your draft to ${AGENTFLOW_OUTPUT_DIR}/draft.md.",
      tokens
    );
    expect(result).toBe("Save your draft to /abs/runs/exec/artifacts/draft.md.");
  });

  it("substitutes the $NAME shell form", () => {
    const result = substituteAgentflowTokens(
      "Inspect $AGENTFLOW_WORKSPACE before editing.",
      tokens
    );
    expect(result).toBe("Inspect /abs/repo before editing.");
  });

  it("substitutes the bare NAME form when surrounded by word boundaries", () => {
    const result = substituteAgentflowTokens(
      "The packet path is AGENTFLOW_CONTEXT_PACKET.",
      tokens
    );
    expect(result).toBe("The packet path is /abs/runs/exec/runtime/context.json.");
  });

  it("does not match a token name embedded in a longer identifier", () => {
    const result = substituteAgentflowTokens(
      "AGENTFLOW_WORKSPACE_SUFFIX is not a real var.",
      tokens
    );
    expect(result).toBe("AGENTFLOW_WORKSPACE_SUFFIX is not a real var.");
  });

  it("does not match a $NAME followed by a word character", () => {
    const result = substituteAgentflowTokens(
      "This is $AGENTFLOW_WORKSPACE_FOO and should be left alone.",
      tokens
    );
    expect(result).toBe(
      "This is $AGENTFLOW_WORKSPACE_FOO and should be left alone."
    );
  });

  it("substitutes per-context-item tokens with the pointer path", () => {
    const result = substituteAgentflowTokens(
      "Use the spec at $AGENTFLOW_CONTEXT_SPEC to seed the change.",
      tokens
    );
    expect(result).toBe(
      "Use the spec at /abs/repo/spec.md to seed the change."
    );
  });

  it("leaves unknown AGENTFLOW_ tokens untouched", () => {
    const result = substituteAgentflowTokens(
      "Reference $AGENTFLOW_OUTPUT_DIR and ${AGENTFLOW_DOES_NOT_EXIST}.",
      tokens
    );
    expect(result).toBe(
      "Reference /abs/runs/exec/artifacts and ${AGENTFLOW_DOES_NOT_EXIST}."
    );
  });

  it("ignores any non-AGENTFLOW_ token in the provided map", () => {
    const result = substituteAgentflowTokens(
      "Other vars like $HOME and $PATH must not be touched.",
      { ...tokens, HOME: "/should/not/apply", PATH: "/also/not" }
    );
    expect(result).toBe(
      "Other vars like $HOME and $PATH must not be touched."
    );
  });

  it("handles multiple tokens of different forms in one pass", () => {
    const input =
      "Read AGENTFLOW_CONTEXT_MANIFEST, write to ${AGENTFLOW_OUTPUT_DIR}/out.md, and cd $AGENTFLOW_WORKSPACE.";
    const result = substituteAgentflowTokens(input, tokens);
    expect(result).toBe(
      "Read /abs/runs/exec/agent/context.md, write to /abs/runs/exec/artifacts/out.md, and cd /abs/repo."
    );
  });

  it("returns the input unchanged when there are no tokens to substitute", () => {
    expect(substituteAgentflowTokens("plain text", {})).toBe("plain text");
    expect(substituteAgentflowTokens("", tokens)).toBe("");
  });

  it("does not interpret $$ as an escape; only the inner $NAME matches", () => {
    const result = substituteAgentflowTokens(
      "$$AGENTFLOW_OUTPUT_DIR resolves with the leading $ left in place.",
      tokens
    );
    expect(result).toBe(
      "$/abs/runs/exec/artifacts resolves with the leading $ left in place."
    );
  });
});
