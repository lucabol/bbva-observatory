'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  buildDashboardModel,
  flattenOtelRecords,
  normalizeWebhookRecord
} = require('./observatory');
const { syncGithubPullRequests, syncCopilotMetrics } = require('./github-sync');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const RUNTIME_DIR = process.env.RUNTIME_DIR || path.join(ROOT, 'data', 'runtime');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data', 'sample');
const PORT = Number(process.env.PORT || 3000);
const INCLUDE_SAMPLE_DATA = parseBoolean(process.env.INCLUDE_SAMPLE_DATA, true);
const API_ROUTES = [
  'GET /api/model',
  'GET /api/lifecycle',
  'GET /api/agents',
  'GET /api/ai-usage',
  'GET /api/health',
  'POST /api/settings/github-sync',
  'POST /webhooks/github',
  'POST /otel/v1/traces',
  'POST /ingest/copilot-usage',
  'POST /ingest/ai-provenance'
];

function parseBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function ensureRuntime() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function appendNdjson(fileName, record) {
  ensureRuntime();
  fs.appendFileSync(path.join(RUNTIME_DIR, fileName), `${JSON.stringify(record)}\n`, 'utf8');
}

function readBody(request, limitBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function parseJsonBody(text) {
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(body);
}

function errorPayload(error, statusCode) {
  return {
    error: error.message,
    code: error.code || (statusCode >= 500 ? 'server_error' : 'request_error'),
    status: statusCode,
    hint: error.hint || null,
    sync_phase: error.syncPhase || null,
    sync_phase_label: error.syncPhaseLabel || null,
    context: error.context || null,
    github: error.github || null
  };
}

function withSyncPhase(error, syncPhase, syncPhaseLabel) {
  error.syncPhase = syncPhase;
  error.syncPhaseLabel = syncPhaseLabel;
  error.message = `${syncPhaseLabel} failed: ${error.message}`;
  error.context = { ...(error.context || {}), sync_phase: syncPhase };
  return error;
}

function sendErrorResponse(response, error) {
  if (response.writableEnded) return;
  const statusCode = error.statusCode || 500;
  try {
    sendJson(response, statusCode, errorPayload(error, statusCode));
  } catch (sendError) {
    if (!response.destroyed) response.destroy(sendError);
  }
}

function sendText(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, { 'content-type': contentType });
  response.end(body);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function serveStatic(requestUrl, response) {
  const url = new URL(requestUrl, 'http://localhost');
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!candidate.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, 'Forbidden');
    return;
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    sendText(response, 404, 'Not found');
    return;
  }
  response.writeHead(200, { 'content-type': contentTypeFor(candidate) });
  fs.createReadStream(candidate).pipe(response);
}

function model() {
  return buildDashboardModel({ dataDir: DATA_DIR, runtimeDir: RUNTIME_DIR, includeSampleData: INCLUDE_SAMPLE_DATA });
}

async function handlePostGitHubWebhook(request, response) {
  const payload = parseJsonBody(await readBody(request));
  const event = request.headers['x-github-event'] || payload.event || payload.event_type || null;
  const record = {
    event,
    received_at: new Date().toISOString(),
    payload: payload.payload || payload
  };
  appendNdjson('github-webhooks.ndjson', record);
  sendJson(response, 202, {
    accepted: true,
    normalized: normalizeWebhookRecord(record),
    caveat: 'Local demo endpoint does not verify X-Hub-Signature-256.'
  });
}

async function handlePostOtel(request, response) {
  const payload = parseJsonBody(await readBody(request));
  appendNdjson('otel-spans.ndjson', payload);
  sendJson(response, 202, {
    accepted: true,
    accepted_spans: flattenOtelRecords([payload]).length,
    accepted_shape: payload.resourceSpans ? 'otlp-json' : payload.spans ? 'span-batch-json' : 'single-span-json'
  });
}

async function handlePostCopilotUsage(request, response) {
  const text = await readBody(request, 5_000_000);
  const contentType = request.headers['content-type'] || '';
  const rows = contentType.includes('application/json')
    ? normalizeRowsFromJson(parseJsonBody(text))
    : text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(JSON.parse);
  for (const row of rows) appendNdjson('copilot-usage-users.ndjson', row);
  sendJson(response, 202, { accepted: true, rows: rows.length });
}

async function handlePostAiProvenance(request, response) {
  const text = await readBody(request, 5_000_000);
  const contentType = request.headers['content-type'] || '';
  const rows = contentType.includes('application/json')
    ? normalizeRowsFromJson(parseJsonBody(text))
    : text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(JSON.parse);
  for (const row of rows) appendNdjson('ai-provenance.ndjson', { source: 'edit_provenance', exact: true, ...row });
  sendJson(response, 202, {
    accepted: true,
    rows: rows.length,
    exact_source: 'edit_time_provenance',
    file: path.join(RUNTIME_DIR, 'ai-provenance.ndjson')
  });
}

async function handlePostGitHubSync(request, response) {
  const payload = parseJsonBody(await readBody(request, 1_000_000));
  let summary;
  try {
    summary = await syncGithubPullRequests({
      token: payload.token,
      org: payload.org,
      repositories: payload.repositories,
      includeOrgRepos: payload.includeOrgRepos,
      since: payload.since,
      maxRepos: payload.maxRepos,
      maxPullRequestsPerRepo: payload.maxPullRequestsPerRepo,
      runtimeDir: RUNTIME_DIR
    });
  } catch (error) {
    throw withSyncPhase(error, 'pull_request_fetch', 'Pull request fetching');
  }
  let copilotMetrics = null;
  if (payload.includeCopilotMetrics) {
    try {
      copilotMetrics = await syncCopilotMetrics({
        token: payload.token,
        org: payload.org,
        enterprise: payload.enterprise,
        since: payload.since,
        attributeTo: payload.attributeCopilotTo,
        runtimeDir: RUNTIME_DIR
      });
    } catch (error) {
      throw withSyncPhase(error, 'copilot_usage_metrics', 'Copilot usage metrics fetching');
    }
  }
  sendJson(response, 200, {
    accepted: true,
    ...summary,
    copilot_metrics: copilotMetrics,
    token_stored: false,
    next_step: 'Refresh the dashboard or call GET /api/model to see synced PRs.'
  });
}

function normalizeRowsFromJson(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload.rows && Array.isArray(payload.rows)) return payload.rows;
  return [payload];
}

async function route(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/api/model') return sendJson(response, 200, model());
    if (request.method === 'GET' && url.pathname === '/api/lifecycle') return sendJson(response, 200, model().lifecycle);
    if (request.method === 'GET' && url.pathname === '/api/agents') return sendJson(response, 200, model().agents);
    if (request.method === 'GET' && url.pathname === '/api/ai-usage') return sendJson(response, 200, model().ai_usage);
    if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, {
      ok: true,
      generated_at: new Date().toISOString(),
      include_sample_data: INCLUDE_SAMPLE_DATA,
      routes: API_ROUTES
    });

    if (request.method === 'POST' && url.pathname === '/webhooks/github') return handlePostGitHubWebhook(request, response);
    if (request.method === 'POST' && url.pathname === '/otel/v1/traces') return handlePostOtel(request, response);
    if (request.method === 'POST' && url.pathname === '/ingest/copilot-usage') return handlePostCopilotUsage(request, response);
    if (request.method === 'POST' && url.pathname === '/ingest/ai-provenance') return handlePostAiProvenance(request, response);
    if (request.method === 'POST' && url.pathname === '/api/settings/github-sync') return handlePostGitHubSync(request, response);

    if (request.method === 'GET') return serveStatic(request.url, response);
    sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendErrorResponse(response, error);
  }
}

function requestListener(request, response) {
  route(request, response).catch(error => {
    sendErrorResponse(response, error);
  });
}

if (require.main === module) {
  ensureRuntime();
  const server = http.createServer(requestListener);
  server.listen(PORT, () => {
    console.log(`Sprint AI Flow Observatory running at http://localhost:${PORT}`);
  });
}

module.exports = { route, requestListener };
