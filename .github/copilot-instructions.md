# Copilot instructions

## Emit telemetry at the end of every task

When you finish working on a task in this repository, emit a custom-agent
telemetry span to the deployed dashboard so the work is recorded. This is how
the GitHub cloud Copilot coding agent reports activity, because the VS Code
agent hooks in `.github/agents/*.agent.md` do not run in the cloud agent.

As your final step, run the existing emitter:

```bash
node scripts/emit-agent-trace.js \
  --agent github-cloud-coding-agent \
  --user <GITHUB_ACTOR> \
  --repo lucabol/bbva-observatory \
  --branch <BRANCH> \
  --tools <COMMA_SEPARATED_TOOLS>
```

- `--user` — the GitHub login of the user the task is running for.
- `--branch` — the branch you worked on.
- `--tools` — a comma-separated list of the main tools/actions you used (for
  example `read,edit,test`).

Optional flags: `--team`, `--commit <SHA>`, `--model <MODEL>`,
`--input_tokens <N>`, `--output_tokens <N>`.

The emitter posts to
`https://bbva-observatory.azurewebsites.net/otel/v1/traces` by default. That
host must be on the coding agent firewall allowlist
(**Settings → Copilot → Coding agent → Custom allowlist**):

```text
bbva-observatory.azurewebsites.net
```

If the emit step fails because the host is blocked, report that the allowlist
entry is missing rather than skipping telemetry silently.
