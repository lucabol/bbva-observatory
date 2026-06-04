'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');
const API_ROOT = 'https://api.github.com';

function parseRepositories(input) {
  if (!input) return [];
  const values = Array.isArray(input)
    ? input
    : String(input).split(/[\s,]+/);
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .map(value => value.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, ''))
    .filter(value => /^[^/\s]+\/[^/\s]+$/.test(value)))];
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

async function githubGet(apiPath, token) {
  let response;
  try {
    response = await fetch(`${API_ROOT}${apiPath}`, {
      headers: {
        'accept': 'application/vnd.github+json',
        'user-agent': 'sprint-ai-flow-observatory-demo',
        'x-github-api-version': '2026-03-10',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    });
  } catch (cause) {
    const error = new Error(`Could not reach the GitHub API for ${apiPath}: ${cause.message}`);
    error.statusCode = 502;
    error.code = 'github_network_error';
    error.hint = 'Check internet access, proxy/firewall settings, and whether api.github.com is reachable from the machine running npm start.';
    error.github = { method: 'GET', path: apiPath };
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    const details = parseGitHubError(text);
    const message = details.message || 'request failed';
    const error = new Error(`GitHub API ${response.status} ${response.statusText || ''}: ${message}`.trim());
    error.statusCode = response.status;
    error.code = 'github_api_error';
    error.hint = githubErrorHint(response.status, message);
    error.github = {
      method: 'GET',
      path: apiPath,
      status: response.status,
      status_text: response.statusText,
      message,
      documentation_url: details.documentation_url || null,
      request_id: response.headers.get('x-github-request-id'),
      rate_limit: rateLimitFromHeaders(response.headers)
    };
    throw error;
  }
  return {
    data: text ? JSON.parse(text) : null,
    link: response.headers.get('link'),
    rateLimit: rateLimitFromHeaders(response.headers)
  };
}

function parseGitHubError(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function rateLimitFromHeaders(headers) {
  return {
    limit: headers.get('x-ratelimit-limit'),
    remaining: headers.get('x-ratelimit-remaining'),
    reset: headers.get('x-ratelimit-reset'),
    resource: headers.get('x-ratelimit-resource'),
    used: headers.get('x-ratelimit-used')
  };
}

function githubErrorHint(status, message = '') {
  const normalized = String(message).toLowerCase();
  if (status === 401) return 'The token was rejected. Create a new token and make sure it is pasted correctly.';
  if (status === 403 && normalized.includes('saml')) return 'Authorize this token for the organization SAML/SSO policy in GitHub, then retry. For classic PATs, open the token in GitHub developer settings and use Configure SSO.';
  if (status === 403 && normalized.includes('rate limit')) return 'The token is rate limited. Wait until the reset time or use a token with available GitHub API quota.';
  if (status === 403) return 'The token may not have access to this organization/repository, SSO may need authorization, or GitHub blocked the request.';
  if (status === 404) return 'Check the owner/repo spelling and token access. GitHub returns 404 for private repositories when the token cannot read them.';
  if (status === 422) return 'Check the request inputs, especially repository names, dates, and limits.';
  if (status >= 500) return 'GitHub returned a server error. Retry in a moment and check GitHub status if it persists.';
  return 'Check the GitHub token, organization/repository names, and network connectivity.';
}

function nextPathFromLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') {
      const url = new URL(match[1]);
      return `${url.pathname}${url.search}`;
    }
  }
  return null;
}

async function listPaginated(apiPath, token, options = {}) {
  const request = options.request || githubGet;
  const maxItems = clampNumber(options.maxItems, 1, 10000, 100);
  const rows = [];
  let nextPath = apiPath;
  let lastRateLimit = null;
  while (nextPath && rows.length < maxItems) {
    const result = await request(nextPath, token);
    const data = Array.isArray(result.data) ? result.data : [];
    rows.push(...data);
    lastRateLimit = result.rateLimit || lastRateLimit;
    nextPath = nextPathFromLink(result.link);
  }
  return { rows: rows.slice(0, maxItems), rateLimit: lastRateLimit };
}

async function discoverOrgRepos(org, token, options = {}) {
  if (!org) return { repos: [], rateLimit: null };
  const maxRepos = clampNumber(options.maxRepos, 1, 500, 20);
  const endpoint = `/orgs/${encodeURIComponent(org)}/repos?type=all&sort=updated&direction=desc&per_page=100`;
  const result = await listPaginated(endpoint, token, { ...options, maxItems: maxRepos });
  return {
    repos: result.rows.map(repo => repo.full_name).filter(Boolean),
    rateLimit: result.rateLimit
  };
}

async function pullRequestsForRepo(repoFullName, token, options = {}) {
  const [owner, repo] = repoFullName.split('/');
  const maxPullRequests = clampNumber(options.maxPullRequestsPerRepo, 1, 200, 25);
  const since = options.since ? new Date(options.since) : null;
  const listEndpoint = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  const listed = await listPaginated(listEndpoint, token, { ...options, maxItems: maxPullRequests });
  const candidates = listed.rows.filter(pr => !since || new Date(pr.updated_at || pr.created_at) >= since);
  const normalized = [];
  let lastRateLimit = listed.rateLimit;
  for (const item of candidates.slice(0, maxPullRequests)) {
    const detail = await (options.request || githubGet)(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${item.number}`, token);
    const commits = await listPaginated(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${item.number}/commits?per_page=100`, token, { ...options, maxItems: 250 });
    lastRateLimit = commits.rateLimit || detail.rateLimit || lastRateLimit;
    normalized.push(normalizePullRequest(detail.data, commits.rows, repoFullName));
  }
  return { pullRequests: normalized, seen: listed.rows.length, saved: normalized.length, rateLimit: lastRateLimit };
}

function normalizePullRequest(pr, commits, repoFullName) {
  return {
    repo: repoFullName,
    number: pr.number,
    title: pr.title,
    head_ref: pr.head?.ref,
    base_ref: pr.base?.ref,
    user_login: pr.user?.login,
    created_at: pr.created_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at,
    merged: Boolean(pr.merged_at || pr.merged),
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    labels: (pr.labels || []).map(label => label.name || label).filter(Boolean),
    milestone: pr.milestone?.title || null,
    commits: commits.map(commit => ({
      sha: commit.sha,
      committed_at: commit.commit?.committer?.date || commit.commit?.author?.date
    }))
  };
}

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function upsertPullRequests(outputFile, pullRequests) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const existing = readJsonArray(outputFile);
  const byKey = new Map(existing.map(item => [`${item.repo}#${item.number}`, item]));
  for (const pr of pullRequests) {
    byKey.set(`${pr.repo}#${pr.number}`, pr);
  }
  const rows = [...byKey.values()].sort((a, b) => `${a.repo}#${a.number}`.localeCompare(`${b.repo}#${b.number}`));
  fs.writeFileSync(outputFile, JSON.stringify(rows, null, 2), 'utf8');
  return { before: existing.length, after: rows.length, upserted: pullRequests.length };
}

async function syncGithubPullRequests(options = {}) {
  const token = String(options.token || '').trim();
  if (!token) {
    const error = new Error('GitHub token is required for live sync.');
    error.statusCode = 400;
    throw error;
  }
  const runtimeDir = options.runtimeDir || DEFAULT_RUNTIME_DIR;
  const outputFile = options.outputFile || path.join(runtimeDir, 'github-pull-requests.json');
  const maxRepos = clampNumber(options.maxRepos, 1, 500, 20);
  const explicitRepos = parseRepositories(options.repositories || options.repos || options.repo);
  const shouldDiscoverOrgRepos = !explicitRepos.length || parseBoolean(options.includeOrgRepos, false);
  const org = String(options.org || '').trim();
  let discovered = { repos: [], rateLimit: null };
  if (shouldDiscoverOrgRepos) {
    try {
      discovered = await discoverOrgRepos(org, token, { ...options, maxRepos });
    } catch (error) {
      error.message = `Failed to discover repositories for organization "${org}": ${error.message}`;
      error.context = { ...(error.context || {}), org };
      throw error;
    }
  }
  const repos = [...new Set([...explicitRepos, ...discovered.repos])].slice(0, maxRepos);
  if (!repos.length) {
    const error = new Error('Enter at least one repository or organization.');
    error.statusCode = 400;
    throw error;
  }

  const allPullRequests = [];
  const repoSummaries = [];
  let lastRateLimit = discovered.rateLimit;
  for (const repo of repos) {
    let result;
    try {
      result = await pullRequestsForRepo(repo, token, options);
    } catch (error) {
      error.message = `Failed to sync repository "${repo}": ${error.message}`;
      error.context = { ...(error.context || {}), repo };
      throw error;
    }
    allPullRequests.push(...result.pullRequests);
    repoSummaries.push({ repo, prs_seen: result.seen, prs_saved: result.saved });
    lastRateLimit = result.rateLimit || lastRateLimit;
  }
  const write = upsertPullRequests(outputFile, allPullRequests);
  return {
    repos_scanned: repos.length,
    repos,
    pull_requests_fetched: allPullRequests.length,
    output_file: outputFile,
    write,
    repo_summaries: repoSummaries,
    org_discovery_used: shouldDiscoverOrgRepos,
    rate_limit: lastRateLimit
  };
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyFeatureTotal(feature) {
  return { feature, loc_added_sum: 0, loc_deleted_sum: 0, loc_suggested_to_add_sum: 0 };
}

function addToFeature(map, feature, added, deleted, suggested) {
  const entry = map.get(feature) || emptyFeatureTotal(feature);
  entry.loc_added_sum += toNumber(added);
  entry.loc_deleted_sum += toNumber(deleted);
  entry.loc_suggested_to_add_sum += toNumber(suggested);
  map.set(feature, entry);
}

// Extracts AI LoC for every feature bucket the response exposes. Per the Copilot
// metrics nuance, the numerator must sum code completions AND the agentic feature
// blocks (agent_edit, chat_panel_agent_mode, chat_panel_custom_mode); looking only
// at inline completions wildly undercounts agent-heavy work.
function extractFeatureTotals(dayMetrics) {
  const map = new Map();

  // 1. Richer user/enterprise export already shaped as per-feature LoC rows.
  const explicitFeatures = Array.isArray(dayMetrics.totals_by_feature) && dayMetrics.totals_by_feature.length
    ? dayMetrics.totals_by_feature
    : Array.isArray(dayMetrics.totals_by_language_feature) && dayMetrics.totals_by_language_feature.length
      ? dayMetrics.totals_by_language_feature
      : [];
  for (const entry of explicitFeatures) {
    addToFeature(map, entry.feature || 'unknown', entry.loc_added_sum, entry.loc_deleted_sum, entry.loc_suggested_to_add_sum);
  }

  // 2. IDE code completions bucket from the standard org/enterprise metrics API.
  const completions = dayMetrics.copilot_ide_code_completions;
  if (completions && Array.isArray(completions.editors)) {
    for (const editor of completions.editors) {
      for (const model of editor.models || []) {
        for (const language of model.languages || []) {
          addToFeature(
            map,
            'code_completion',
            language.total_code_lines_accepted,
            0,
            language.total_code_lines_suggested
          );
        }
      }
    }
  }

  // 3. IDE chat bucket (agent + custom mode). The metrics API reports activity
  //    counts and accepted lines for chat-driven code insertions.
  const ideChat = dayMetrics.copilot_ide_chat;
  if (ideChat && Array.isArray(ideChat.editors)) {
    for (const editor of ideChat.editors) {
      for (const model of editor.models || []) {
        const added = model.total_chat_insertion_events ?? model.total_code_lines_accepted ?? 0;
        addToFeature(map, 'chat_panel_agent_mode', added, 0, 0);
      }
    }
  }

  return [...map.values()];
}

function normalizeCopilotMetricsRow(dayMetrics, context = {}) {
  const features = extractFeatureTotals(dayMetrics);
  const row = {
    day: dayMetrics.date || dayMetrics.day,
    source: 'copilot_metrics_api',
    scope: context.scope || 'org',
    used_agent: features.some(f => f.feature === 'agent_edit' && (f.loc_added_sum || f.loc_deleted_sum)),
    totals_by_feature: features.length ? features : [emptyFeatureTotal('code_completion')]
  };
  if (context.org) row.org = context.org;
  if (context.enterprise) row.enterprise_id = context.enterprise;
  if (context.repo) row.repo = context.repo;
  return row;
}

function withCopilotMetricsContext(error, context = {}) {
  error.context = {
    ...(error.context || {}),
    org: context.org || null,
    enterprise: context.enterprise || null,
    repo: context.repo || null,
    copilot_metrics_scope: context.enterprise ? 'enterprise' : 'org',
    copilot_metrics_endpoint: context.endpoint || null
  };

  if (error.statusCode === 404) {
    error.hint = context.enterprise
      ? `GitHub returned 404 for the enterprise Copilot metrics endpoint. Verify enterprise slug "${context.enterprise}", token access to that enterprise, and Copilot metrics/report permissions. The repository is not used for this API call; it is only used later to attribute returned lines.`
      : `GitHub returned 404 for the organization Copilot metrics endpoint. Verify organization slug "${context.org}" and that the token owner can access the org and has Copilot metrics permission. The repository is not used for this API call; it is only used later to attribute returned lines.`;
  } else if (error.statusCode === 403) {
    error.hint = context.enterprise
      ? `The token can reach GitHub but cannot read enterprise Copilot metrics for "${context.enterprise}". Check enterprise Copilot metrics permissions, SSO authorization, and token scopes.`
      : `The token can reach GitHub but cannot read organization Copilot metrics for "${context.org}". Check Copilot metrics permissions, SSO authorization, and token scopes.`;
  }

  return error;
}

async function fetchCopilotMetrics(options = {}) {
  const token = String(options.token || '').trim();
  const request = options.request || githubGet;
  const org = String(options.org || '').trim();
  const enterprise = String(options.enterprise || '').trim();
  if (!org && !enterprise) {
    const error = new Error('A GitHub organization or enterprise is required to fetch Copilot usage metrics.');
    error.statusCode = 400;
    error.code = 'copilot_metrics_scope_missing';
    error.hint = 'Enter an organization in the Settings tab (or provide an enterprise) before requesting Copilot usage metrics.';
    throw error;
  }
  const params = [];
  if (options.since) {
    const sinceDate = new Date(options.since);
    if (!Number.isNaN(sinceDate.getTime())) params.push(`since=${encodeURIComponent(sinceDate.toISOString())}`);
  }
  const query = params.length ? `?${params.join('&')}` : '';

  // For enterprises, prefer the 28-day user-level report. It carries the richer
  // per-feature LoC breakdown (agent_edit + chat_panel_* blocks) the standard
  // metrics endpoint omits, so the AI-usage numerator is not undercounted.
  // Fall back to the standard /copilot/metrics endpoint if that report is not
  // available (e.g. missing scope or unsupported tenant).
  if (enterprise) {
    const reportPath = `/enterprises/${encodeURIComponent(enterprise)}/copilot/metrics/reports/enterprise-28-day/latest`;
    try {
      const report = await request(reportPath, token);
      const reportDays = normalizeUserLevelReport(report.data);
      if (reportDays.length) {
        return { days: reportDays, rateLimit: report.rateLimit, scope: 'enterprise', org, enterprise, source_endpoint: 'enterprise-28-day' };
      }
    } catch (error) {
      if (!(error.statusCode === 404 || error.statusCode === 403 || error.statusCode === 422)) throw error;
      // Otherwise fall through to the standard metrics endpoint below.
    }
  }

  const base = enterprise
    ? `/enterprises/${encodeURIComponent(enterprise)}/copilot/metrics`
    : `/orgs/${encodeURIComponent(org)}/copilot/metrics`;
  const endpoint = `${base}${query}`;
  let result;
  try {
    result = await request(endpoint, token);
  } catch (error) {
    throw withCopilotMetricsContext(error, { org, enterprise, repo: options.attributeTo, endpoint });
  }
  const days = Array.isArray(result.data) ? result.data : [];
  return { days, rateLimit: result.rateLimit, scope: enterprise ? 'enterprise' : 'org', org, enterprise, source_endpoint: 'copilot-metrics' };
}

// The 28-day user-level report groups per-user rows that already carry
// totals_by_feature / totals_by_language_feature. Aggregate them by day so each
// returned object matches the shape normalizeCopilotMetricsRow expects.
function normalizeUserLevelReport(report) {
  const rows = Array.isArray(report) ? report : (report && Array.isArray(report.users) ? report.users : []);
  if (!rows.length) return [];
  const byDay = new Map();
  for (const row of rows) {
    const day = row.day || row.date || 'unknown';
    const features = Array.isArray(row.totals_by_feature) && row.totals_by_feature.length
      ? row.totals_by_feature
      : Array.isArray(row.totals_by_language_feature) && row.totals_by_language_feature.length
        ? row.totals_by_language_feature
        : [];
    if (!features.length) continue;
    const map = byDay.get(day) || new Map();
    for (const entry of features) {
      addToFeature(map, entry.feature || 'unknown', entry.loc_added_sum, entry.loc_deleted_sum, entry.loc_suggested_to_add_sum);
    }
    byDay.set(day, map);
  }
  return [...byDay.entries()].map(([day, map]) => ({ date: day, totals_by_feature: [...map.values()] }));
}

function readNdjsonRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function copilotRowKey(row) {
  return `${row.source || 'manual'}::${row.scope || ''}::${row.org || row.enterprise_id || ''}::${row.repo || ''}::${row.day || ''}`;
}

function upsertCopilotUsageRows(outputFile, rows) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const existing = readNdjsonRows(outputFile);
  const incomingKeys = new Set(rows.map(copilotRowKey));
  const kept = existing.filter(row => !incomingKeys.has(copilotRowKey(row)));
  const merged = [...kept, ...rows];
  fs.writeFileSync(outputFile, merged.length ? merged.map(row => JSON.stringify(row)).join('\n') + '\n' : '', 'utf8');
  return { before: existing.length, after: merged.length, upserted: rows.length };
}

async function syncCopilotMetrics(options = {}) {
  const token = String(options.token || '').trim();
  if (!token) {
    const error = new Error('GitHub token is required for live sync.');
    error.statusCode = 400;
    throw error;
  }
  const runtimeDir = options.runtimeDir || DEFAULT_RUNTIME_DIR;
  const outputFile = options.outputFile || path.join(runtimeDir, 'copilot-usage-users.ndjson');
  const repo = parseRepositories(options.attributeTo).slice(0, 1)[0] || '';
  const fetched = await fetchCopilotMetrics(options);
  const rows = fetched.days
    .filter(day => day && day.date)
    .map(day => normalizeCopilotMetricsRow(day, {
      org: fetched.org,
      enterprise: fetched.enterprise,
      scope: fetched.scope,
      repo
    }));
  const write = upsertCopilotUsageRows(outputFile, rows);
  const totals = rows.reduce((acc, row) => {
    for (const feature of row.totals_by_feature) {
      acc.loc_added += feature.loc_added_sum;
      acc.loc_deleted += feature.loc_deleted_sum;
      acc.loc_suggested += feature.loc_suggested_to_add_sum;
      acc.features.add(feature.feature);
    }
    return acc;
  }, { loc_added: 0, loc_deleted: 0, loc_suggested: 0, features: new Set() });
  return {
    scope: fetched.scope,
    source_endpoint: fetched.source_endpoint || null,
    org: fetched.org || null,
    enterprise: fetched.enterprise || null,
    attributed_repo: repo || null,
    days_fetched: rows.length,
    features_captured: [...totals.features],
    copilot_loc_added: totals.loc_added,
    copilot_loc_deleted: totals.loc_deleted,
    copilot_loc_changed: totals.loc_added + totals.loc_deleted,
    copilot_loc_suggested: totals.loc_suggested,
    output_file: outputFile,
    write,
    rate_limit: fetched.rateLimit
  };
}

module.exports = {
  discoverOrgRepos,
  fetchCopilotMetrics,
  githubGet,
  normalizeCopilotMetricsRow,
  normalizePullRequest,
  normalizeUserLevelReport,
  parseRepositories,
  pullRequestsForRepo,
  syncCopilotMetrics,
  syncGithubPullRequests,
  upsertCopilotUsageRows,
  upsertPullRequests
};
