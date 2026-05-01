# Agentflow Real-World Issues

This suite evaluates Agentflow against pinned real MIT GitHub issues. It is meant for serious prompt, context, tool, and delivery iteration after the generated capability suite has proven basic eval plumbing.

The third-party repositories are not committed. Materialize them locally under ignored `eval-repos/agentflow-realworld-issues/`:

```bash
npm run setup:realworld-evals
npm run dev -- eval validate evals/agentflow-realworld-issues
npm run dev -- eval run evals/agentflow-realworld-issues --variant current --scenario all --trials 1 --concurrency 1
```

For prompt iteration, run repeated trials after the single-trial pass is stable:

```bash
npm run dev -- eval run evals/agentflow-realworld-issues --variant current --scenario all --trials 5 --concurrency 1
```

## Scenarios

| Scenario | Repo | What It Tests |
| --- | --- | --- |
| `validator-url-port-no-protocol` | `validatorjs/validator.js` | URL parser regression after protocol detection changes. |
| `validator-slug-charset` | `validatorjs/validator.js` | Regex and charset correctness without overbroad acceptance. |
| `date-fns-utc-now-functions` | `date-fns/date-fns` | Cross-cutting current-date helper behavior with `UTCDate`. |
| `date-fns-french-ordinal-architecture` | `date-fns/date-fns` | Locale/formatting architecture for French ordinal month output. |
| `execa-escaped-newline-template` | `sindresorhus/execa` | Template parser behavior for escaped newlines. |

Each scenario stores source issue metadata, a hidden PR oracle, and an Agentflow-owned regression patch. The node sees the pinned repo and local task/regression test, but not the upstream PR patch.

Generated repos, dependency installs, and eval outputs must remain uncommitted.
