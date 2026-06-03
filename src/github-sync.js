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

module.exports = {
  discoverOrgRepos,
  githubGet,
  normalizePullRequest,
  parseRepositories,
  pullRequestsForRepo,
  syncGithubPullRequests,
  upsertPullRequests
};
