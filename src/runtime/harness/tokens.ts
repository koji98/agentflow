/**
 * Substitution helper for AGENTFLOW_* tokens that may appear in user-authored
 * prompts and rubrics.
 *
 * Agentflow already inlines context, lists declared artifacts with absolute
 * paths, and sets every AGENTFLOW_* env var in the harness spawn environment,
 * so prompts almost never need to reference these tokens directly. This helper
 * exists as a forgiveness layer: if a user pastes a token like
 * `$AGENTFLOW_OUTPUT_DIR` or `AGENTFLOW_CONTEXT_PACKET` into a prompt, we
 * substitute it with the absolute path before the model sees the prompt.
 *
 * Recognised forms per token name (one pass, longest-name first):
 *   - `${NAME}` — explicit braces
 *   - `$NAME`   — shell-style, terminated by a non-word character
 *   - `NAME`    — bare token, only when surrounded by word boundaries
 *
 * Unknown tokens (typos, unrelated identifiers, env vars we do not own) are
 * left untouched.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function substituteAgentflowTokens(
  text: string,
  tokens: Record<string, string>
): string {
  if (!text) {
    return text;
  }

  const names = Object.keys(tokens).filter((name) => /^AGENTFLOW_[A-Z0-9_]+$/.test(name));
  if (names.length === 0) {
    return text;
  }

  // Sort longest-first so the alternation prefers the most specific match
  // (for example AGENTFLOW_CONTEXT_PACKET over a hypothetical AGENTFLOW_CONTEXT
  // prefix collision).
  names.sort((a, b) => b.length - a.length);
  const escaped = names.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `\\$\\{(${escaped})\\}|\\$(${escaped})\\b|\\b(${escaped})\\b`,
    "g"
  );

  return text.replace(pattern, (match, braced: string | undefined, dollar: string | undefined, bare: string | undefined) => {
    const name = braced ?? dollar ?? bare;
    if (!name) {
      return match;
    }
    const value = tokens[name];
    return value ?? match;
  });
}
