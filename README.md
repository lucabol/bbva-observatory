# Sprint AI Flow Dashboard

A self-contained local demo that implements the three requested solution areas:

1. **#2 Lifecycle / cycle time:** branch-created or first-commit start through merged PR completion, with merge frequency per configured sprint.
2. **#4 Custom-agent observability:** OpenTelemetry-style agent session normalization with agent name/type, executing user, team, repository, branch, tools, duration, tokens, and running/completed status.
3. **#5 AI usage percentage:** Copilot LoC numerator divided by GitHub PR/commit changed-line denominator, with feature splits such as `agent_edit`, `chat_panel_agent_mode`, and `chat_panel_custom_mode`.

The app has no third-party runtime dependencies; it uses Node.js built-ins, sample fixtures, and a static browser dashboard.

## Run

```powershell
npm test
npm start
```

Open <http://localhost:3000>.

Optional checks:

```powershell
npm run check
node -e "console.log(require('./src/observatory').buildDashboardModel().lifecycle.summary)"
```

## What is implemented

- `src/observatory.js` - analytics engine for lifecycle records, sprint bucketing, OTel agent traces, Copilot usage rows, and AI line percentages.
- `src/github-sync.js` - dependency-free GitHub REST sync for live organization/repository pull request data.
- `src/server.js` - local HTTP server, static dashboard, model APIs, and ingestion endpoints.
- `public/` - browser UI with Lifecycle, Agent observability, AI usage, and Data/caveats tabs.
- `data/sample/` - realistic synthetic GitHub webhook, GitHub PR, Copilot usage, enterprise PR metric, and OTel span fixtures.
- `data/runtime/` - local append-only runtime ingest files created by POST endpoints or scripts.
- `scripts/fetch-github-pr.js` - optional GitHub REST collector for a real PR.
- `scripts/import-github-audit-log.js` - converts retained GitHub Enterprise audit-log branch creation events into exact lifecycle start records.
- `scripts/emit-agent-trace.js` - emits simplified custom-agent trace spans directly to the local trace endpoint without an OTel collector.
- `.github/agents/direct-telemetry-reviewer.agent.md` - VS Code custom agent definition that uses agent-scoped hooks to emit direct telemetry.
- `scripts/sample-custom-agent.js` - standalone agent-runtime simulator that posts its own telemetry directly to `/otel/v1/traces`; this is not itself a VS Code custom agent definition.
- `scripts/vscode-agent-telemetry-hook.js` - hook command used by the VS Code custom agent to convert agent lifecycle events into trace spans.
- `test/observatory.test.js` - regression coverage for exact/fallback lifecycle starts, merged-only KPIs, sprint windows, agent user attribution, AI percentage clamping, and sample model totals.

## APIs

### Dashboard APIs

```text
GET /api/model       Full normalized model
GET /api/lifecycle   Lifecycle summary and records
GET /api/agents      Agent summary and invocations
GET /api/ai-usage    AI line usage summary and records
GET /api/health      Health check
```

### Ingestion APIs

```text
POST /webhooks/github        GitHub create/push/pull_request payloads
POST /otel/v1/traces         OTLP JSON or simplified span JSON
POST /ingest/copilot-usage   Copilot users-1-day NDJSON or JSON rows
POST /ingest/ai-provenance   Exact edit-time AI LoC provenance rows
POST /api/settings/github-sync Live GitHub org/repo PR sync from Settings
```

### Settings page live sync

Open the **Settings** tab, enter a GitHub token plus either an organization, explicit repositories, or both, then click **Fetch live GitHub PRs**. The sync writes normalized PR records to `data/runtime/github-pull-requests.json` and refreshes the dashboard.

If sync fails, the Settings tab prints the local HTTP status, GitHub request path, request id, rate-limit details, and a suggested fix when the server has that information. If it only reports that the browser could not reach the local Settings API, make sure `npm start` is still running on the same port. If it shows `Method not allowed`, the browser is using updated static files but the Node server process is still the old code. Stop `npm start`, run `npm start` again, and retry. `GET /api/health` lists the active API routes; it should include `POST /api/settings/github-sync`.

For `Resource protected by organization SAML enforcement`, authorize the token for that organization: open GitHub **Settings → Developer settings → Personal access tokens**, select the token, choose **Configure SSO**, and authorize it for the organization. Fine-grained tokens must also be granted access to the target organization/repositories with read access to pull requests and contents.

Fields:

- **GitHub token:** required for private repositories and higher API limits. It is used for the request and is not written to runtime files. If **Remember token in this browser** is checked, it is saved in browser `localStorage`; use **Clear saved token** to remove it.
- **Organization:** optional; saved in browser `localStorage`; discovers repositories from `GET /orgs/{org}/repos` only when the repo list is empty or **Also discover repositories from this organization** is checked.
- **Repositories:** optional newline/comma-separated `OWNER/REPO` list; saved in browser `localStorage`.
- **Since:** optional lower bound for recently updated PRs; saved in browser `localStorage`.
- **Max repos / Max PRs per repo:** safety limits for demos; saved in browser `localStorage`.

Equivalent API call:

```powershell
$body = @{
  token = 'github_pat_or_gh_token_with_repo_read'
  org = 'OWNER_OR_ORG'
  repositories = "OWNER/REPO`nOWNER/ANOTHER-REPO"
  includeOrgRepos = $false
  since = '2026-06-01'
  maxRepos = 20
  maxPullRequestsPerRepo = 25
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/settings/github-sync -Body $body -ContentType 'application/json'
```

Example GitHub webhook simulation:

```powershell
$payload = Get-Content .\data\sample\github-webhooks.ndjson -First 1 | ConvertFrom-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/webhooks/github -Headers @{ 'X-GitHub-Event' = 'create' } -Body ($payload.payload | ConvertTo-Json -Depth 20) -ContentType 'application/json'
```

Example Copilot usage ingestion:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/ingest/copilot-usage -InFile .\data\sample\copilot-usage-users.ndjson -ContentType 'application/x-ndjson'
```

Example OTel ingestion:

```powershell
$span = Get-Content .\data\sample\otel-spans.ndjson -First 1 | ConvertFrom-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/otel/v1/traces -Body ($span | ConvertTo-Json -Depth 20) -ContentType 'application/json'
```

Example exact AI provenance ingestion:

```powershell
$row = @{
  repo = 'OWNER/REPO'
  sprint_id = 'sprint-25'
  pr_number = 42
  commit_sha = 'abc123'
  user_id = 'USER'
  feature = 'agent_edit'
  loc_added_sum = 42
  loc_deleted_sum = 8
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/ingest/ai-provenance -Body $row -ContentType 'application/json'
```

## Optional real PR collector

Fetch a real GitHub PR into `data/runtime/github-pull-requests.json`:

```powershell
$env:GITHUB_TOKEN = 'github_pat_or_gh_token_with_repo_read'
node .\scripts\fetch-github-pr.js OWNER REPO PULL_NUMBER
```

Then refresh the dashboard. The collector pulls PR metadata and PR commits via GitHub REST APIs and stores the normalized denominator fields: `created_at`, `closed_at`, `merged_at`, `additions`, `deletions`, `changed_files`, labels, milestone, branch, and commit dates.

## Step-by-step exactness guide

Use the Data/caveats tab as the operator guide. The short rule is: exact values require a captured source of truth. If that source was not captured, the demo must show a named fallback instead of implying exactness.

### 1. Historical branch creation without webhooks

Exact historical branch creation is possible only when GitHub Enterprise retained the Git ref creation event, or when audit-log streaming was already enabled.

1. Get an enterprise admin token with `read:audit_log`.
2. Import retained Git events:

   ```powershell
   $env:GITHUB_TOKEN = 'classic_pat_with_read_audit_log'
   node .\scripts\import-github-audit-log.js --enterprise ENTERPRISE --repo OWNER/REPO --since 2026-05-01
   ```

3. The importer keeps branch ref creation rows and maps timestamp, repository, branch ref, and actor into `data/runtime/github-webhooks.ndjson` as normalized `create` records. It can also consume an exported JSON or NDJSON file:

   ```powershell
   node .\scripts\import-github-audit-log.js --input .\audit-log-export.ndjson
   ```

4. If audit-log retention has expired and no stream exists, exact branch creation cannot be reconstructed from Git commits. Use `first_commit_fallback`; if commits are unavailable, use `pr_created_fallback`.

### 2. Exact Copilot lines per PR/commit without Copilot metrics

GitHub PR and commit APIs provide total changed lines, not authorship of those lines. Without Copilot metrics, exact per-PR or per-commit AI attribution requires provenance captured when the AI edit is made.

1. Wrap the demo agent/editor flow so every accepted AI patch records repo, branch, file path, added/deleted LoC, executing user, and session id before human edits are mixed in.
2. After commit and PR creation, attach `commit_sha` and `pr_number` to the provenance row.
3. Post rows to `POST /ingest/ai-provenance` or append to `data/runtime/ai-provenance.ndjson`:

   ```json
   {"repo":"OWNER/REPO","sprint_id":"sprint-25","pr_number":42,"commit_sha":"abc123","user_id":"USER","feature":"agent_edit","loc_added_sum":42,"loc_deleted_sum":8}
   ```

4. Exact provenance rows replace Copilot estimate rows for the same repo/sprint in the numerator, preventing double counting. If provenance was not captured at edit time, show a directional aggregate or manual attestation. Do not label historical PR/commit AI-line counts as exact.

### 3. Live custom-agent traces without an OTel collector

Without OTel, live traces still require the custom agent runtime to emit events. The demo accepts simplified trace JSON at the same trace endpoint, so a custom agent can post directly instead of using an OTel collector.

This workspace is configured to send agent telemetry to the deployed dashboard by default:

```text
https://bbva-observatory.azurewebsites.net/otel/v1/traces
```

1. Generate a trace directly from the CLI, or make your custom agent emit the same JSON shape:

   ```powershell
   node .\scripts\emit-agent-trace.js --agent payment-reviewer --user USER --team TEAM --repo OWNER/REPO --branch feature/example --tools readFile,edit,test
   ```

2. The script posts an `invoke_agent` span and linked child `execute_tool` spans to `POST /otel/v1/traces`.
3. Use `--running` to leave the root span open and show an active live session.
4. VS Code custom agents are declarative customization files. In current VS Code docs they are `.agent.md` Markdown files with YAML frontmatter in `.github/agents`, not executable JavaScript. The included `.github/agents/direct-telemetry-reviewer.agent.md` file is the custom agent definition. It uses agent-scoped hooks to run `scripts/vscode-agent-telemetry-hook.js`, which is the executable telemetry bridge.

   To try it in VS Code:

   1. Make sure `https://bbva-observatory.azurewebsites.net/api/health` is reachable.
   2. Enable `chat.useCustomAgentHooks`.
   3. Select **Direct Telemetry Reviewer** in Chat.
   4. Stop the agent session; the hook posts the completed session trace to the deployed `POST /otel/v1/traces` endpoint.

   To run this agent from the GitHub cloud agent (the Copilot chat on github.com), allow the dashboard host through the coding agent firewall. The cloud agent blocks outbound requests to hosts that are not on its allowlist, so the telemetry hook cannot reach the dashboard until you add it. In the repository **Settings → Copilot → Coding agent → Custom allowlist**, add the host (domain only, not the full path):

   ```text
   bbva-observatory.azurewebsites.net
   ```

   Save the allowlist, then start a new cloud agent session so the change takes effect.

5. Run the standalone simulator to see how an agent runtime can collect its own spans while it works and flush them directly to the same route:

   ```powershell
   node .\scripts\sample-custom-agent.js --user USER --team TEAM --repo OWNER/REPO --branch feature/example --commit abc123 --pr 42
   ```

   Use `--dry-run` to print the payload without posting it. The sample logs prompt length only; it does not log raw prompts or source code.

6. If the agent cannot emit runtime events or hooks, show only inferred activity from branch names, bot authorship, commits, or PR metadata.

## Live data mode

Run with only runtime data, excluding sample fixtures:

```powershell
$env:INCLUDE_SAMPLE_DATA = 'false'
npm start
```

The app still loads `config.json` for sprint windows, but the Lifecycle, AI usage, and Agent tabs only show rows imported or ingested under `data/runtime`.

## Data model notes

### Lifecycle (#2)

Cycle start uses this order:

```text
branch create webhook timestamp -> first commit timestamp -> PR created timestamp
```

Cycle completion is **merged PR only**:

```text
cycle_end_at = pr_merged_at
```

Closed-unmerged PRs are displayed but excluded from cycle-time and merge-frequency KPIs. This avoids treating abandoned work as delivered work.

Sprints are deterministic. `data/sample/config.json` defines sprint windows, and the engine also recognizes `sprint-24` style branch names, labels, and milestones.

### Agent observability (#4)

The normalizer accepts simplified spans and OTLP JSON. It looks for configurable attribute names in `src/config.js`, including:

- `gen_ai.agent.name`
- `github.copilot.agent.type`
- `github.copilot.git.repository`
- `github.copilot.git.branch`
- `github.copilot.git.commit_sha`
- `github.user`, `github.actor`, `enduser.id`, or `user.id` for executing user
- `team.id` for team attribution

For real enterprise rollout, inject user/team through managed OTel resource attributes, collector enrichment, or direct custom-agent span attributes. Do not rely on prompt content for identity.

### AI usage percentage (#5)

The demo computes:

```text
AI usage % = (Copilot loc_added_sum + Copilot loc_deleted_sum) / (GitHub additions + GitHub deletions)
```

The value is clamped to 100% and marked when clamping occurs. Zero-denominator rows return `null` instead of dividing by zero.

This is a **directional** metric unless `data/runtime/ai-provenance.ndjson` contains edit-time provenance for that repo/sprint. Exact provenance rows replace Copilot estimate rows for the same repo/sprint in the numerator. Copilot usage reports are often aggregated by user/day/feature, while GitHub PR changed lines are repository/PR-specific. For production, align the numerator and denominator to the same reporting grain, preferably repo/team/sprint, and state the attribution assumptions.

## Caveats intentionally shown in the UI

- Branch-created timestamps are exact only when captured prospectively by `create` webhooks.
- Historical branches use first-commit fallback when no retained GitHub Enterprise audit-log branch creation event or audit-log stream row exists.
- Cycle-time KPIs count merged PRs only.
- Copilot LoC metrics are directional and depend on telemetry/plugin coverage unless exact edit-time provenance is ingested.
- The local webhook endpoint does not verify `X-Hub-Signature-256`; add that before production use.
- Direct custom-agent traces are exact only when emitted by the agent runtime; otherwise show inferred activity only.
