'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAiUsageRecords,
  buildDashboardModel,
  buildLifecycleRecords,
  normalizeAgentInvocations,
  resolveSprint
} = require('../src/observatory');
const { githubGet, syncGithubPullRequests } = require('../src/github-sync');
const { clearRuntimeData } = require('../src/server');

const sampleDir = path.resolve(__dirname, '..', 'data', 'sample');

function emptyRuntimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flow-observatory-'));
}

test('lifecycle uses exact branch create, first commit fallback, and excludes closed-unmerged PRs', () => {
  const config = {
    sprints: [{ id: 'sprint-1', start: '2026-01-01T00:00:00.000Z', end: '2026-01-15T00:00:00.000Z' }]
  };
  const webhooks = [
    { event: 'create', received_at: '2026-01-02T08:00:00.000Z', payload: { ref_type: 'branch', ref: 'sprint-1/feature/a', repository: { full_name: 'o/r' }, sender: { login: 'ana' } } }
  ];
  const pullRequests = [
    { repo: 'o/r', number: 1, head_ref: 'sprint-1/feature/a', created_at: '2026-01-02T09:00:00.000Z', merged_at: '2026-01-02T10:00:00.000Z', merged: true, additions: 10, deletions: 1, commits: [{ sha: 'a', committed_at: '2026-01-02T08:30:00.000Z' }] },
    { repo: 'o/r', number: 2, head_ref: 'sprint-1/feature/b', created_at: '2026-01-03T09:00:00.000Z', merged_at: '2026-01-03T12:00:00.000Z', merged: true, additions: 10, deletions: 1, commits: [{ sha: 'b', committed_at: '2026-01-03T08:00:00.000Z' }] },
    { repo: 'o/r', number: 3, head_ref: 'sprint-1/feature/c', created_at: '2026-01-04T09:00:00.000Z', closed_at: '2026-01-04T12:00:00.000Z', merged: false, additions: 10, deletions: 1, commits: [{ sha: 'c', committed_at: '2026-01-04T08:00:00.000Z' }] }
  ];

  const records = buildLifecycleRecords({ webhooks, pullRequests, config });
  const exact = records.find(record => record.pr_number === 1);
  const fallback = records.find(record => record.pr_number === 2);
  const closed = records.find(record => record.pr_number === 3);

  assert.equal(exact.start_source, 'exact_branch_create');
  assert.equal(exact.cycle_time_hours, 2);
  assert.equal(fallback.start_source, 'first_commit_fallback');
  assert.equal(fallback.cycle_time_hours, 4);
  assert.equal(closed.status, 'closed_unmerged');
  assert.equal(closed.cycle_time_hours, null);
  assert.equal(closed.included_in_cycle_kpis, false);
});

test('sprint windows bucket unlabeled work deterministically', () => {
  const result = resolveSprint({ branch: 'feature/no-label', labels: [], milestone: null, at: '2026-01-10T12:00:00.000Z' }, {
    sprints: [{ id: 'sprint-window', start: '2026-01-01T00:00:00.000Z', end: '2026-01-15T00:00:00.000Z' }]
  });
  assert.deepEqual(result, { id: 'sprint-window', source: 'configured_window' });
});

test('agent normalization captures executing user, tool calls, tokens, and running status', () => {
  const invocations = normalizeAgentInvocations([
    {
      trace_id: 't1',
      span_id: 'root',
      name: 'invoke_agent demo-agent',
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:01:00.000Z',
      resource_attributes: { 'github.user': 'ana', 'team.id': 'platform' },
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'demo-agent',
        'github.copilot.agent.type': 'custom',
        'github.copilot.git.repository': 'https://github.com/o/r.git',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 20
      },
      status_code: 'OK'
    },
    {
      trace_id: 't1',
      span_id: 'tool',
      parent_span_id: 'root',
      name: 'execute_tool edit',
      start_time: '2026-01-01T00:00:10.000Z',
      end_time: '2026-01-01T00:00:20.000Z',
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'edit' }
    },
    {
      trace_id: 't2',
      span_id: 'running-root',
      name: 'invoke_agent running-agent',
      start_time: '2026-01-01T00:00:00.000Z',
      resource_attributes: { 'github.user': 'marco' },
      attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'running-agent' }
    }
  ]);

  const demo = invocations.find(item => item.agent_name === 'demo-agent');
  const running = invocations.find(item => item.agent_name === 'running-agent');
  assert.equal(demo.executing_user, 'ana');
  assert.equal(demo.team_id, 'platform');
  assert.equal(demo.repo, 'o/r');
  assert.equal(demo.tool_calls, 1);
  assert.deepEqual(demo.tools, ['edit']);
  assert.equal(demo.input_tokens, 100);
  assert.equal(demo.output_tokens, 20);
  assert.equal(running.status, 'running');
});

test('AI usage handles feature aggregation, clamping, and zero denominators', () => {
  const result = buildAiUsageRecords({
    copilotUsageRows: [
      { repo: 'o/r', sprint_id: 's1', totals_by_feature: [{ feature: 'agent_edit', loc_added_sum: 20, loc_deleted_sum: 0, loc_suggested_to_add_sum: 1 }] },
      { repo: 'o/r', sprint_id: 's2', totals_by_feature: [{ feature: 'agent_edit', loc_added_sum: 1, loc_deleted_sum: 0 }] }
    ],
    lifecycleRecords: [
      { repo: 'o/r', sprint_id: 's1', status: 'merged', additions: 10, deletions: 0 }
    ],
    config: {}
  });

  const clamped = result.records.find(record => record.sprint_id === 's1');
  const zero = result.records.find(record => record.sprint_id === 's2');
  assert.equal(clamped.raw_ai_usage_pct, 200);
  assert.equal(clamped.ai_usage_pct, 100);
  assert.equal(clamped.pct_clamped, true);
  assert.equal(zero.total_loc_changed, 0);
  assert.equal(zero.ai_usage_pct, null);
});

test('exact AI provenance replaces estimates at the same repo and sprint', () => {
  const result = buildAiUsageRecords({
    copilotUsageRows: [
      { repo: 'o/r', sprint_id: 's1', totals_by_feature: [{ feature: 'agent_edit', loc_added_sum: 90, loc_deleted_sum: 10 }] }
    ],
    aiProvenanceRows: [
      { repo: 'o/r', sprint_id: 's1', pr_number: 7, commit_sha: 'abc123', user_id: 'ana', feature: 'agent_edit', loc_added_sum: 9, loc_deleted_sum: 1 }
    ],
    lifecycleRecords: [
      { repo: 'o/r', sprint_id: 's1', status: 'merged', additions: 10, deletions: 10 }
    ],
    config: {}
  });

  const record = result.records.find(item => item.sprint_id === 's1');
  assert.equal(record.ai_loc_changed, 10);
  assert.equal(record.ai_usage_pct, 50);
  assert.equal(record.numerator_source, 'edit_provenance');
  assert.equal(record.exact_ai_attribution, true);
  assert.deepEqual(record.pr_numbers, [7]);
  assert.equal(result.provenance_records[0].commit_sha, 'abc123');
});

test('runtime-only mode excludes sample data but keeps sample sprint configuration', () => {
  const model = buildDashboardModel({ dataDir: sampleDir, runtimeDir: emptyRuntimeDir(), includeSampleData: false });

  assert.equal(model.sources.include_sample_data, false);
  assert.equal(model.sources.data_mode, 'runtime_only');
  assert.equal(model.sources.pull_requests, 0);
  assert.ok(model.config.sprints.length > 0);
});

test('clearRuntimeData removes runtime dashboard files and leaves unrelated files', () => {
  const runtimeDir = emptyRuntimeDir();
  fs.writeFileSync(path.join(runtimeDir, 'github-pull-requests.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(runtimeDir, 'otel-spans.ndjson'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(runtimeDir, 'keep-me.txt'), 'do not delete', 'utf8');

  const result = clearRuntimeData(runtimeDir);

  assert.deepEqual(result.deleted.sort(), ['github-pull-requests.json', 'otel-spans.ndjson']);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'github-pull-requests.json')), false);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'otel-spans.ndjson')), false);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'keep-me.txt'), 'utf8'), 'do not delete');
});

test('GitHub sync fetches org PRs and upserts normalized runtime data without storing token', async () => {
  const runtimeDir = emptyRuntimeDir();
  const calls = [];
  const request = async apiPath => {
    calls.push(apiPath);
    if (apiPath.startsWith('/orgs/acme/repos')) {
      return { data: [{ full_name: 'acme/payments' }], link: null, rateLimit: { remaining: '4999' } };
    }
    if (apiPath.startsWith('/repos/acme/payments/pulls?')) {
      return { data: [{ number: 42, updated_at: '2026-06-02T08:00:00.000Z' }], link: null };
    }
    if (apiPath === '/repos/acme/payments/pulls/42') {
      return {
        data: {
          number: 42,
          title: 'Live PR',
          head: { ref: 'feature/live' },
          base: { ref: 'main' },
          user: { login: 'ana' },
          created_at: '2026-06-02T07:00:00.000Z',
          closed_at: '2026-06-02T08:00:00.000Z',
          merged_at: '2026-06-02T08:00:00.000Z',
          additions: 12,
          deletions: 3,
          changed_files: 2,
          labels: [{ name: 'sprint-25' }],
          milestone: { title: 'Sprint 25' }
        },
        link: null
      };
    }
    if (apiPath === '/repos/acme/payments/pulls/42/commits?per_page=100') {
      return { data: [{ sha: 'abc', commit: { committer: { date: '2026-06-02T07:30:00.000Z' } } }], link: null };
    }
    throw new Error(`Unexpected API path ${apiPath}`);
  };

  const result = await syncGithubPullRequests({
    token: 'secret-token',
    org: 'acme',
    runtimeDir,
    request
  });
  const output = fs.readFileSync(path.join(runtimeDir, 'github-pull-requests.json'), 'utf8');
  const rows = JSON.parse(output);

  assert.equal(result.repos_scanned, 1);
  assert.equal(result.pull_requests_fetched, 1);
  assert.equal(rows[0].repo, 'acme/payments');
  assert.equal(rows[0].number, 42);
  assert.equal(rows[0].commits[0].sha, 'abc');
  assert.equal(output.includes('secret-token'), false);
  assert.ok(calls.includes('/repos/acme/payments/pulls/42'));
});

test('GitHub sync does not discover org repos when explicit repos are provided by default', async () => {
  const runtimeDir = emptyRuntimeDir();
  const calls = [];
  const request = async apiPath => {
    calls.push(apiPath);
    if (apiPath.startsWith('/orgs/acme/repos')) throw new Error('org discovery should not run');
    if (apiPath.startsWith('/repos/acme/payments/pulls?')) {
      return { data: [], link: null };
    }
    throw new Error(`Unexpected API path ${apiPath}`);
  };

  const result = await syncGithubPullRequests({
    token: 'secret-token',
    org: 'acme',
    repositories: 'acme/payments',
    runtimeDir,
    request
  });

  assert.equal(result.org_discovery_used, false);
  assert.equal(result.repos_scanned, 1);
  assert.deepEqual(result.repos, ['acme/payments']);
  assert.equal(calls.some(call => call.startsWith('/orgs/acme/repos')), false);
});

test('GitHub sync adds repository context to API failures', async () => {
  const runtimeDir = emptyRuntimeDir();
  const request = async apiPath => {
    if (apiPath.startsWith('/repos/acme/missing/pulls?')) {
      const error = new Error('GitHub API 404 Not Found: Not Found');
      error.statusCode = 404;
      error.code = 'github_api_error';
      error.hint = 'Check the owner/repo spelling and token access.';
      error.github = { method: 'GET', path: apiPath, status: 404, message: 'Not Found' };
      throw error;
    }
    throw new Error(`Unexpected API path ${apiPath}`);
  };

  await assert.rejects(
    syncGithubPullRequests({
      token: 'secret-token',
      repositories: 'acme/missing',
      runtimeDir,
      request
    }),
    error => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'github_api_error');
      assert.equal(error.context.repo, 'acme/missing');
      assert.match(error.message, /Failed to sync repository "acme\/missing"/);
      assert.match(error.hint, /owner\/repo/);
      assert.equal(error.github.status, 404);
      return true;
    }
  );
});

test('GitHub API SAML failures include an SSO authorization hint', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    text: async () => JSON.stringify({
      message: 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.',
      documentation_url: 'https://docs.github.com/articles/authenticating-to-a-github-organization-with-saml-single-sign-on/'
    }),
    headers: {
      get: name => ({
        'x-github-request-id': 'request-1',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4976',
        'x-ratelimit-reset': '1780387043',
        'x-ratelimit-resource': 'core',
        'x-ratelimit-used': '24'
      }[String(name).toLowerCase()] || null)
    }
  });

  try {
    await assert.rejects(
      githubGet('/repos/github/github-app/pulls?state=all', 'secret-token'),
      error => {
        assert.equal(error.statusCode, 403);
        assert.equal(error.code, 'github_api_error');
        assert.match(error.hint, /SAML\/SSO/);
        assert.equal(error.github.request_id, 'request-1');
        assert.equal(error.github.documentation_url, 'https://docs.github.com/articles/authenticating-to-a-github-organization-with-saml-single-sign-on/');
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('sample dashboard model implements all three requested views', () => {
  const model = buildDashboardModel({ dataDir: sampleDir, runtimeDir: emptyRuntimeDir() });

  assert.equal(model.lifecycle.summary.merged_pull_requests, 2);
  assert.equal(model.lifecycle.summary.closed_unmerged_pull_requests, 1);
  assert.equal(model.lifecycle.summary.median_cycle_time_hours, 27.75);
  assert.equal(model.lifecycle.summary.merge_frequency_by_sprint.find(row => row.sprint_id === 'sprint-24').count, 2);
  assert.equal(model.agents.summary.custom_invocations, 3);
  assert.equal(model.agents.summary.active_sessions, 1);
  assert.equal(model.agents.summary.unique_users, 3);
  assert.equal(model.ai_usage.summary.total_loc_changed, 210);
  assert.equal(model.ai_usage.summary.ai_loc_changed, 152);
  assert.equal(model.ai_usage.summary.ai_usage_pct, 72.4);
});
