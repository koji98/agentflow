# Plugin Extraction

Extract a plugin when at least one is true:

- The workflow composes multiple CLIs or fragile command sequences.
- Credentials need Agentflow auth isolation.
- Agents need stable JSON I/O.
- External mutation needs policy boundaries.
- The capability will be reused across graphs.
- Auditability matters beyond a single run.

Do not extract a plugin when:

- A native repo/device CLI is enough and has good `--help`.
- The command is one-off.
- The wrapper would hide useful native flags or errors.
- The real problem is graph authoring, context, or validation.

For plugin work, use `agentflow-plugins`.
