'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ATTRIBUTE_KEYS, AGENT_FEATURES } = require('./config');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'data', 'sample');
const RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return fallback;
  return JSON.parse(text);
}

function readJsonArray(filePath) {
  const value = readJson(filePath, []);
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        error.message = `${filePath}:${index + 1}: ${error.message}`;
        throw error;
      }
    });
}

function parseBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function loadData(options = {}) {
  const sampleDir = options.dataDir || SAMPLE_DIR;
  const runtimeDir = options.runtimeDir || RUNTIME_DIR;
  const includeSampleData = Object.prototype.hasOwnProperty.call(options, 'includeSampleData')
    ? Boolean(options.includeSampleData)
    : parseBoolean(process.env.INCLUDE_SAMPLE_DATA, true);
  const config = {
    timezone: 'UTC',
    defaultRepo: 'bbva/demo-payments',
    sprints: [],
    agentFeatureBuckets: AGENT_FEATURES,
    ...readJson(path.join(sampleDir, 'config.json'), {}),
    ...readJson(path.join(runtimeDir, 'config.json'), {})
  };

  return {
    config,
    includeSampleData,
    webhooks: [
      ...(includeSampleData ? readNdjson(path.join(sampleDir, 'github-webhooks.ndjson')) : []),
      ...readNdjson(path.join(runtimeDir, 'github-webhooks.ndjson'))
    ],
    pullRequests: [
      ...(includeSampleData ? readJsonArray(path.join(sampleDir, 'github-pull-requests.json')) : []),
      ...readJsonArray(path.join(runtimeDir, 'github-pull-requests.json'))
    ],
    copilotUsageRows: [
      ...(includeSampleData ? readNdjson(path.join(sampleDir, 'copilot-usage-users.ndjson')) : []),
      ...readNdjson(path.join(runtimeDir, 'copilot-usage-users.ndjson'))
    ],
    aiProvenanceRows: [
      ...(includeSampleData ? readNdjson(path.join(sampleDir, 'ai-provenance.ndjson')) : []),
      ...readNdjson(path.join(runtimeDir, 'ai-provenance.ndjson'))
    ],
    enterpriseReports: [
      ...(includeSampleData ? readJsonArray(path.join(sampleDir, 'copilot-usage-enterprise.json')) : []),
      ...readJsonArray(path.join(runtimeDir, 'copilot-usage-enterprise.json'))
    ],
    otelRecords: [
      ...(includeSampleData ? readNdjson(path.join(sampleDir, 'otel-spans.ndjson')) : []),
      ...readNdjson(path.join(runtimeDir, 'otel-spans.ndjson'))
    ]
  };
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIso(value) {
  const date = parseDate(value);
  return date ? date.toISOString() : null;
}

function hoursBetween(start, end) {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (!startDate || !endDate) return null;
  return round((endDate.getTime() - startDate.getTime()) / 36e5, 2);
}

function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stripBranchRef(ref) {
  if (!ref) return null;
  return String(ref).replace(/^refs\/heads\//, '');
}

function normalizeRepoIdentifier(repo) {
  if (!repo) return null;
  const raw = String(repo).trim();
  if (!raw) return null;
  const withoutGit = raw.replace(/\.git$/, '');
  const githubMatch = withoutGit.match(/github\.com[:/]([^/]+\/[^/]+)$/i);
  if (githubMatch) return githubMatch[1];
  const slashParts = withoutGit.split('/').filter(Boolean);
  if (slashParts.length >= 2 && !withoutGit.includes('://')) {
    return slashParts.slice(-2).join('/');
  }
  return raw;
}

function makeBranchKey(repo, branch) {
  return `${normalizeRepoIdentifier(repo) || ''}::${stripBranchRef(branch) || ''}`;
}

function setEarliest(map, key, value) {
  const date = parseDate(value);
  if (!key || !date) return;
  const existing = parseDate(map.get(key));
  if (!existing || date < existing) map.set(key, date.toISOString());
}

function normalizeWebhookRecord(record) {
  const payload = record.payload || record;
  const event = record.event || record.event_type || record.eventName || record.headers?.['x-github-event'] || record.headers?.['X-GitHub-Event'] || inferWebhookEvent(payload);
  const receivedAt = record.received_at || record.receivedAt || record.timestamp || record.delivered_at || new Date().toISOString();

  if (event === 'create' && payload.ref_type === 'branch') {
    return {
      kind: 'branch_created',
      repo: normalizeRepoIdentifier(payload.repository?.full_name),
      branch: stripBranchRef(payload.ref),
      actor: payload.sender?.login || payload.pusher?.name || null,
      at: toIso(receivedAt),
      source: 'webhook:create'
    };
  }

  if (event === 'push' && payload.created === true && String(payload.ref || '').startsWith('refs/heads/')) {
    return {
      kind: 'branch_first_push',
      repo: normalizeRepoIdentifier(payload.repository?.full_name),
      branch: stripBranchRef(payload.ref),
      actor: payload.sender?.login || payload.pusher?.name || null,
      at: toIso(receivedAt),
      first_commit_at: earliestCommitDate(payload.commits) || toIso(payload.head_commit?.timestamp) || toIso(receivedAt),
      source: 'webhook:push.created'
    };
  }

  if (event === 'pull_request' && payload.pull_request) {
    return {
      kind: 'pull_request',
      action: payload.action || null,
      at: toIso(receivedAt),
      pull_request: normalizePullRequest(payload.pull_request, payload.repository?.full_name)
    };
  }

  return { kind: 'ignored', event, at: toIso(receivedAt) };
}

function inferWebhookEvent(payload) {
  if (payload?.ref_type && payload?.ref) return 'create';
  if (payload?.ref && Object.prototype.hasOwnProperty.call(payload, 'before') && Object.prototype.hasOwnProperty.call(payload, 'after')) return 'push';
  if (payload?.pull_request) return 'pull_request';
  return 'unknown';
}

function earliestCommitDate(commits) {
  if (!Array.isArray(commits)) return null;
  const dates = commits
    .map(commit => parseDate(commit.timestamp || commit.committed_at || commit.commit?.committer?.date || commit.commit?.author?.date))
    .filter(Boolean)
    .sort((a, b) => a - b);
  return dates[0] ? dates[0].toISOString() : null;
}

function normalizePullRequest(pr, repoOverride) {
  const labels = Array.isArray(pr.labels)
    ? pr.labels.map(label => typeof label === 'string' ? label : label.name).filter(Boolean)
    : [];
  const commits = Array.isArray(pr.commits)
    ? pr.commits
    : Array.isArray(pr.commit_records)
      ? pr.commit_records
      : [];

  return {
    repo: normalizeRepoIdentifier(pr.repo || pr.repository || pr.repository_full_name || pr.base?.repo?.full_name || repoOverride),
    number: pr.number,
    title: pr.title || '',
    head_ref: stripBranchRef(pr.head_ref || pr.head?.ref || pr.branch),
    base_ref: stripBranchRef(pr.base_ref || pr.base?.ref),
    user_login: pr.user_login || pr.user?.login || pr.author || null,
    created_at: toIso(pr.created_at),
    closed_at: toIso(pr.closed_at),
    merged_at: toIso(pr.merged_at || (pr.merged === true ? pr.closed_at : null)),
    merged: Boolean(pr.merged || pr.merged_at),
    additions: numberOrZero(pr.additions),
    deletions: numberOrZero(pr.deletions),
    changed_files: numberOrZero(pr.changed_files),
    labels,
    milestone: typeof pr.milestone === 'string' ? pr.milestone : pr.milestone?.title || null,
    commits: commits.map(commit => ({
      sha: commit.sha,
      committed_at: toIso(commit.committed_at || commit.timestamp || commit.commit?.committer?.date || commit.commit?.author?.date)
    }))
  };
}

function dedupePullRequests(pullRequests) {
  const byKey = new Map();
  for (const raw of pullRequests) {
    const pr = normalizePullRequest(raw);
    if (!pr.repo || !pr.number) continue;
    const key = `${pr.repo}#${pr.number}`;
    const existing = byKey.get(key) || {};
    byKey.set(key, mergeDefined(existing, pr));
  }
  return [...byKey.values()].sort((a, b) => `${a.repo}#${a.number}`.localeCompare(`${b.repo}#${b.number}`));
}

function mergeDefined(left, right) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
  }
  return merged;
}

function buildLifecycleRecords({ webhooks = [], pullRequests = [], config = {} } = {}) {
  const branchCreatedAt = new Map();
  const firstPushAt = new Map();
  const prFromWebhooks = [];

  for (const record of webhooks) {
    const normalized = normalizeWebhookRecord(record);
    if (normalized.kind === 'branch_created') {
      setEarliest(branchCreatedAt, makeBranchKey(normalized.repo, normalized.branch), normalized.at);
    }
    if (normalized.kind === 'branch_first_push') {
      setEarliest(firstPushAt, makeBranchKey(normalized.repo, normalized.branch), normalized.first_commit_at || normalized.at);
    }
    if (normalized.kind === 'pull_request') {
      prFromWebhooks.push(normalized.pull_request);
    }
  }

  return dedupePullRequests([...prFromWebhooks, ...pullRequests]).map(pr => {
    const key = makeBranchKey(pr.repo, pr.head_ref);
    const branchStart = branchCreatedAt.get(key) || null;
    const firstCommit = earliestCommitDate(pr.commits) || firstPushAt.get(key) || null;
    const prCreated = pr.created_at || null;
    const cycleStart = branchStart || firstCommit || prCreated;
    const isMerged = Boolean(pr.merged_at);
    const cycleEnd = isMerged ? pr.merged_at : null;
    const status = isMerged ? 'merged' : pr.closed_at ? 'closed_unmerged' : 'open';
    const startSource = branchStart ? 'exact_branch_create' : firstCommit ? 'first_commit_fallback' : 'pr_created_fallback';
    const sprint = resolveSprint({ branch: pr.head_ref, labels: pr.labels, milestone: pr.milestone, at: pr.merged_at || pr.created_at }, config);

    return {
      repo: pr.repo,
      pr_number: pr.number,
      title: pr.title,
      branch: pr.head_ref,
      base_ref: pr.base_ref,
      author: pr.user_login,
      status,
      sprint_id: sprint.id,
      sprint_source: sprint.source,
      branch_created_at: branchStart,
      first_commit_at: firstCommit,
      pr_created_at: prCreated,
      pr_closed_at: pr.closed_at,
      pr_merged_at: pr.merged_at,
      cycle_start_at: cycleStart,
      cycle_end_at: cycleEnd,
      cycle_time_hours: cycleEnd ? hoursBetween(cycleStart, cycleEnd) : null,
      start_source: startSource,
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.changed_files,
      total_changed_lines: pr.additions + pr.deletions,
      included_in_cycle_kpis: isMerged
    };
  });
}

function resolveSprint({ branch, labels = [], milestone, at }, config = {}) {
  const labelText = labels.join(' ');
  const explicit = [branch, labelText, milestone].filter(Boolean).join(' ');
  const match = explicit.match(/sprint[-_\s]?(\d+)/i);
  if (match) return { id: `sprint-${match[1]}`, source: 'work_item_metadata' };

  const date = parseDate(at);
  if (date && Array.isArray(config.sprints)) {
    const sprint = config.sprints.find(item => {
      const start = parseDate(item.start);
      const end = parseDate(item.end);
      return start && end && date >= start && date < end;
    });
    if (sprint) return { id: sprint.id, source: 'configured_window' };
  }

  return { id: 'unassigned', source: 'unassigned' };
}

function summarizeLifecycle(records, enterpriseReports = []) {
  const merged = records.filter(record => record.status === 'merged');
  const cycleTimes = merged.map(record => record.cycle_time_hours).filter(value => Number.isFinite(value));
  const sourceCounts = countBy(records, record => record.start_source);
  const mergeFrequencyBySprint = Object.entries(countBy(merged, record => record.sprint_id)).map(([sprint_id, count]) => ({ sprint_id, count }));

  return {
    total_pull_requests: records.length,
    merged_pull_requests: merged.length,
    closed_unmerged_pull_requests: records.filter(record => record.status === 'closed_unmerged').length,
    open_pull_requests: records.filter(record => record.status === 'open').length,
    median_cycle_time_hours: percentile(cycleTimes, 0.5),
    p85_cycle_time_hours: percentile(cycleTimes, 0.85),
    exact_branch_start_pct: records.length ? round((sourceCounts.exact_branch_create || 0) * 100 / records.length, 1) : 0,
    branch_start_quality: sourceCounts,
    merge_frequency_by_sprint: mergeFrequencyBySprint,
    copilot_pr_metrics: summarizeCopilotPrMetrics(enterpriseReports)
  };
}

function summarizeCopilotPrMetrics(enterpriseReports = []) {
  const totals = {
    total_created: 0,
    total_merged: 0,
    total_created_by_copilot: 0,
    total_merged_created_by_copilot: 0,
    median_minutes_to_merge_values: [],
    median_minutes_to_merge_copilot_authored_values: []
  };

  for (const report of enterpriseReports) {
    for (const day of report.day_totals || []) {
      const pr = day.pull_requests || {};
      totals.total_created += numberOrZero(pr.total_created);
      totals.total_merged += numberOrZero(pr.total_merged);
      totals.total_created_by_copilot += numberOrZero(pr.total_created_by_copilot);
      totals.total_merged_created_by_copilot += numberOrZero(pr.total_merged_created_by_copilot);
      if (Number.isFinite(Number(pr.median_minutes_to_merge))) totals.median_minutes_to_merge_values.push(Number(pr.median_minutes_to_merge));
      if (Number.isFinite(Number(pr.median_minutes_to_merge_copilot_authored))) totals.median_minutes_to_merge_copilot_authored_values.push(Number(pr.median_minutes_to_merge_copilot_authored));
    }
  }

  return {
    total_created: totals.total_created,
    total_merged: totals.total_merged,
    total_created_by_copilot: totals.total_created_by_copilot,
    total_merged_created_by_copilot: totals.total_merged_created_by_copilot,
    median_minutes_to_merge: percentile(totals.median_minutes_to_merge_values, 0.5),
    median_minutes_to_merge_copilot_authored: percentile(totals.median_minutes_to_merge_copilot_authored_values, 0.5)
  };
}

function percentile(values, p) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return round(sorted[0], 2);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return round(sorted[lower] * (1 - weight) + sorted[upper] * weight, 2);
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function flattenOtelRecords(records) {
  const spans = [];
  for (const record of records) {
    if (record?.resourceSpans) {
      spans.push(...flattenOtlpPayload(record));
    } else if (Array.isArray(record?.spans)) {
      spans.push(...record.spans.map(span => normalizeSpanShape(span, record.resource_attributes || record.resourceAttributes || {})));
    } else {
      spans.push(normalizeSpanShape(record));
    }
  }
  return spans.filter(span => span.traceId && span.spanId);
}

function flattenOtlpPayload(payload) {
  const spans = [];
  for (const resourceSpan of payload.resourceSpans || []) {
    const resourceAttributes = attributesArrayToObject(resourceSpan.resource?.attributes || []);
    for (const scopeSpan of resourceSpan.scopeSpans || []) {
      for (const span of scopeSpan.spans || []) {
        spans.push(normalizeSpanShape({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: attributesArrayToObject(span.attributes || []),
          status: span.status
        }, resourceAttributes));
      }
    }
  }
  return spans;
}

function attributesArrayToObject(attributes) {
  const result = {};
  for (const attr of attributes) {
    if (!attr?.key) continue;
    result[attr.key] = otlpValueToJs(attr.value || {});
  }
  return result;
}

function otlpValueToJs(value) {
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'intValue')) return Number(value.intValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'boolValue')) return Boolean(value.boolValue);
  if (value.arrayValue?.values) return value.arrayValue.values.map(otlpValueToJs);
  return null;
}

function normalizeSpanShape(span, resourceAttributes = {}) {
  const start = span.start_time || span.startTime || span.startTimeUnixNano;
  const end = span.end_time || span.endTime || span.endTimeUnixNano;
  return {
    traceId: span.trace_id || span.traceId,
    spanId: span.span_id || span.spanId,
    parentSpanId: span.parent_span_id || span.parentSpanId || null,
    name: span.name || '',
    startTime: normalizeSpanTime(start),
    endTime: normalizeSpanTime(end),
    attributes: span.attributes || {},
    resourceAttributes: span.resource_attributes || span.resourceAttributes || resourceAttributes || {},
    statusCode: span.status_code || span.statusCode || span.status?.code || null
  };
}

function normalizeSpanTime(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d+$/.test(value) && value.length > 12) {
    return new Date(Number(BigInt(value) / 1000000n)).toISOString();
  }
  if (typeof value === 'number' && value > 10_000_000_000_000) {
    return new Date(Number(BigInt(Math.trunc(value)) / 1000000n)).toISOString();
  }
  return toIso(value);
}

function normalizeAgentInvocations(records = []) {
  const spans = flattenOtelRecords(records);
  const byTrace = groupBy(spans, span => span.traceId);
  const invocations = [];

  for (const traceSpans of Object.values(byTrace)) {
    for (const root of traceSpans) {
      const attrs = combinedAttributes(root);
      const operation = getAttr(attrs, ATTRIBUTE_KEYS.operationName);
      const agentName = getAttr(attrs, ATTRIBUTE_KEYS.agentName);
      const isInvokeAgent = operation === 'invoke_agent' || root.name.startsWith('invoke_agent') || (agentName && !root.parentSpanId);
      if (!isInvokeAgent) continue;

      const descendants = collectDescendants(root, traceSpans);
      const toolSpans = descendants.filter(span => getAttr(combinedAttributes(span), ATTRIBUTE_KEYS.operationName) === 'execute_tool' || span.name.startsWith('execute_tool'));
      const start = parseDate(root.startTime);
      const end = parseDate(root.endTime);
      const running = !end;
      const durationMs = start ? Math.max(0, (end || new Date()).getTime() - start.getTime()) : null;
      const status = running ? 'running' : String(root.statusCode || '').toUpperCase().includes('ERROR') ? 'error' : 'ok';

      invocations.push({
        trace_id: root.traceId,
        span_id: root.spanId,
        session_id: getAttr(attrs, ['gen_ai.conversation.id', 'session.id']) || root.traceId,
        agent_name: agentName || root.name.replace(/^invoke_agent\s*/, '') || 'unknown-agent',
        agent_type: getAttr(attrs, ATTRIBUTE_KEYS.agentType) || 'unknown',
        executing_user: getAttr(attrs, ATTRIBUTE_KEYS.executingUser) || 'unknown',
        team_id: getAttr(attrs, ATTRIBUTE_KEYS.teamId) || 'unknown',
        repo: normalizeRepoIdentifier(getAttr(attrs, ATTRIBUTE_KEYS.repository)),
        branch: stripBranchRef(getAttr(attrs, ATTRIBUTE_KEYS.branch)),
        commit_sha: getAttr(attrs, ATTRIBUTE_KEYS.commitSha) || null,
        model: getAttr(attrs, ATTRIBUTE_KEYS.model) || 'unknown',
        started_at: root.startTime,
        ended_at: root.endTime,
        duration_ms: durationMs === null ? null : Math.round(durationMs),
        tool_calls: toolSpans.length,
        tools: [...new Set(toolSpans.map(span => getAttr(combinedAttributes(span), ATTRIBUTE_KEYS.toolName) || span.name.replace(/^execute_tool\s*/, '')).filter(Boolean))],
        input_tokens: numberOrZero(getAttr(attrs, ATTRIBUTE_KEYS.inputTokens)),
        output_tokens: numberOrZero(getAttr(attrs, ATTRIBUTE_KEYS.outputTokens)),
        status,
        error_type: getAttr(attrs, ATTRIBUTE_KEYS.errorType) || null
      });
    }
  }

  return invocations.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

function combinedAttributes(span) {
  return { ...(span.resourceAttributes || {}), ...(span.attributes || {}) };
}

function getAttr(attributes, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(attributes, key) && attributes[key] !== null && attributes[key] !== undefined && attributes[key] !== '') {
      return attributes[key];
    }
  }
  return null;
}

function groupBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item) || 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

function collectDescendants(root, spans) {
  const childrenByParent = groupBy(spans.filter(span => span.parentSpanId), span => span.parentSpanId);
  const result = [];
  const stack = [...(childrenByParent[root.spanId] || [])];
  while (stack.length) {
    const span = stack.pop();
    result.push(span);
    stack.push(...(childrenByParent[span.spanId] || []));
  }
  return result;
}

function summarizeAgents(invocations) {
  const custom = invocations.filter(invocation => invocation.agent_type === 'custom');
  const durations = invocations.map(invocation => invocation.duration_ms).filter(Number.isFinite);
  const topAgents = Object.entries(groupAggregate(invocations, invocation => invocation.agent_name)).map(([agent_name, value]) => ({ agent_name, ...value }));
  const byUser = Object.entries(groupAggregate(invocations, invocation => invocation.executing_user)).map(([executing_user, value]) => ({ executing_user, ...value }));

  return {
    total_invocations: invocations.length,
    active_sessions: invocations.filter(invocation => invocation.status === 'running').length,
    custom_invocations: custom.length,
    unique_users: new Set(invocations.map(invocation => invocation.executing_user).filter(user => user !== 'unknown')).size,
    total_input_tokens: invocations.reduce((sum, invocation) => sum + invocation.input_tokens, 0),
    total_output_tokens: invocations.reduce((sum, invocation) => sum + invocation.output_tokens, 0),
    avg_duration_ms: round(avg(durations), 0),
    p95_duration_ms: percentile(durations, 0.95),
    top_agents: topAgents.sort((a, b) => b.invocations - a.invocations),
    by_user: byUser.sort((a, b) => b.invocations - a.invocations)
  };
}

function groupAggregate(items, getKey) {
  const groups = {};
  for (const item of items) {
    const key = getKey(item) || 'unknown';
    groups[key] ||= { invocations: 0, users: new Set(), avg_duration_ms_values: [] };
    groups[key].invocations += 1;
    groups[key].users.add(item.executing_user);
    if (Number.isFinite(item.duration_ms)) groups[key].avg_duration_ms_values.push(item.duration_ms);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, {
    invocations: value.invocations,
    users: value.users.size,
    avg_duration_ms: round(avg(value.avg_duration_ms_values), 0)
  }]));
}

function avg(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function flattenCopilotFeatureMetrics(row) {
  const entries = Array.isArray(row.totals_by_feature) && row.totals_by_feature.length
    ? row.totals_by_feature
    : Array.isArray(row.totals_by_language_feature) && row.totals_by_language_feature.length
      ? row.totals_by_language_feature
      : [{
          feature: row.feature || 'unknown',
          loc_added_sum: row.loc_added_sum,
          loc_deleted_sum: row.loc_deleted_sum,
          loc_suggested_to_add_sum: row.loc_suggested_to_add_sum
        }];

  return entries.map(entry => ({
    feature: entry.feature || 'unknown',
    language: entry.language || row.language || null,
    loc_added_sum: numberOrZero(entry.loc_added_sum),
    loc_deleted_sum: numberOrZero(entry.loc_deleted_sum),
    loc_suggested_to_add_sum: numberOrZero(entry.loc_suggested_to_add_sum)
  }));
}

function buildAiUsageRecords({ copilotUsageRows = [], aiProvenanceRows = [], lifecycleRecords = [], config = {} } = {}) {
  const denominatorByKey = new Map();
  for (const record of lifecycleRecords.filter(item => item.status === 'merged')) {
    const key = makeAiKey(record.repo, record.sprint_id);
    const aggregate = denominatorByKey.get(key) || emptyAiAggregate(record.repo, record.sprint_id);
    aggregate.total_loc_added += numberOrZero(record.additions);
    aggregate.total_loc_deleted += numberOrZero(record.deletions);
    aggregate.pr_count += 1;
    denominatorByKey.set(key, aggregate);
  }

  const provenanceRows = normalizeAiProvenanceRows(aiProvenanceRows, config);
  const exactKeys = new Set(provenanceRows.map(row => makeAiKey(row.repo, row.sprint_id)));
  const numeratorByKey = new Map();
  const globalFeatureBreakdown = {};
  for (const row of copilotUsageRows) {
    const scope = resolveAiUsageScope(row, config);
    if (exactKeys.has(scope.key)) continue;
    const aggregate = numeratorByKey.get(scope.key) || emptyAiAggregate(scope.repo, scope.sprint);
    addFeatureMetricsToAggregate(aggregate, row, globalFeatureBreakdown, 'copilot_metrics');
    numeratorByKey.set(scope.key, aggregate);
  }

  for (const row of provenanceRows) {
    const key = makeAiKey(row.repo, row.sprint_id);
    const aggregate = numeratorByKey.get(key) || emptyAiAggregate(row.repo, row.sprint_id);
    addFeatureMetricsToAggregate(aggregate, row, globalFeatureBreakdown, row.source || 'edit_provenance');
    aggregate.exact_ai_attribution = true;
    aggregate.provenance_rows += 1;
    if (row.pr_number !== null && row.pr_number !== undefined) aggregate.pr_numbers.add(row.pr_number);
    if (row.commit_sha) aggregate.commit_shas.add(row.commit_sha);
    numeratorByKey.set(key, aggregate);
  }

  const keys = new Set([...denominatorByKey.keys(), ...numeratorByKey.keys()]);
  const records = [...keys].map(key => {
    const denominator = denominatorByKey.get(key) || emptyAiAggregate(...splitAiKey(key));
    const numerator = numeratorByKey.get(key) || emptyAiAggregate(...splitAiKey(key));
    const totalLoc = denominator.total_loc_added + denominator.total_loc_deleted;
    const aiLoc = numerator.ai_loc_added + numerator.ai_loc_deleted;
    const rawPct = totalLoc > 0 ? aiLoc * 100 / totalLoc : null;
    const numeratorSources = Object.keys(numerator.numerator_sources || {});
    return {
      repo: numerator.repo || denominator.repo,
      sprint_id: numerator.sprint_id || denominator.sprint_id,
      pr_count: denominator.pr_count,
      ai_loc_added: numerator.ai_loc_added,
      ai_loc_deleted: numerator.ai_loc_deleted,
      ai_loc_suggested: numerator.ai_loc_suggested,
      total_loc_added: denominator.total_loc_added,
      total_loc_deleted: denominator.total_loc_deleted,
      total_loc_changed: totalLoc,
      ai_loc_changed: aiLoc,
      ai_usage_pct: rawPct === null ? null : round(clamp(rawPct, 0, 100), 1),
      raw_ai_usage_pct: rawPct === null ? null : round(rawPct, 1),
      pct_clamped: rawPct !== null && rawPct > 100,
      granularity: 'repo_sprint',
      numerator_source: numeratorSources.length ? numeratorSources.join('+') : 'none',
      exact_ai_attribution: Boolean(numerator.exact_ai_attribution),
      provenance_rows: numerator.provenance_rows || 0,
      pr_numbers: [...(numerator.pr_numbers || [])],
      commit_shas: [...(numerator.commit_shas || [])],
      by_feature: Object.values(numerator.by_feature).sort((a, b) => b.ai_loc_added + b.ai_loc_deleted - (a.ai_loc_added + a.ai_loc_deleted))
    };
  }).sort((a, b) => `${a.repo}:${a.sprint_id}`.localeCompare(`${b.repo}:${b.sprint_id}`));

  return {
    records,
    summary: summarizeAiUsage(records),
    by_feature: Object.values(globalFeatureBreakdown).sort((a, b) => b.ai_loc_added + b.ai_loc_deleted - (a.ai_loc_added + a.ai_loc_deleted)),
    provenance_records: summarizeAiProvenanceRows(provenanceRows)
  };
}

function resolveAiUsageScope(row, config = {}) {
  const repo = normalizeRepoIdentifier(row.repo || row.repository || row.repository_full_name || config.defaultRepo);
  const sprint = row.sprint_id || resolveSprint({ branch: row.branch, labels: row.labels || [], milestone: row.milestone, at: row.day || row.timestamp }, config).id;
  return { repo, sprint, key: makeAiKey(repo, sprint) };
}

function addFeatureMetricsToAggregate(aggregate, row, globalFeatureBreakdown, source) {
  aggregate.numerator_sources[source] = (aggregate.numerator_sources[source] || 0) + 1;
  for (const feature of flattenCopilotFeatureMetrics(row)) {
    aggregate.ai_loc_added += feature.loc_added_sum;
    aggregate.ai_loc_deleted += feature.loc_deleted_sum;
    aggregate.ai_loc_suggested += feature.loc_suggested_to_add_sum;
    aggregate.by_feature[feature.feature] ||= { feature: feature.feature, ai_loc_added: 0, ai_loc_deleted: 0, ai_loc_suggested: 0 };
    aggregate.by_feature[feature.feature].ai_loc_added += feature.loc_added_sum;
    aggregate.by_feature[feature.feature].ai_loc_deleted += feature.loc_deleted_sum;
    aggregate.by_feature[feature.feature].ai_loc_suggested += feature.loc_suggested_to_add_sum;
    globalFeatureBreakdown[feature.feature] ||= { feature: feature.feature, ai_loc_added: 0, ai_loc_deleted: 0, ai_loc_suggested: 0 };
    globalFeatureBreakdown[feature.feature].ai_loc_added += feature.loc_added_sum;
    globalFeatureBreakdown[feature.feature].ai_loc_deleted += feature.loc_deleted_sum;
    globalFeatureBreakdown[feature.feature].ai_loc_suggested += feature.loc_suggested_to_add_sum;
  }
}

function normalizeAiProvenanceRows(rows = [], config = {}) {
  return rows.map(row => {
    const scope = resolveAiUsageScope(row, config);
    const features = Array.isArray(row.totals_by_feature) && row.totals_by_feature.length
      ? row.totals_by_feature
      : [{
          feature: row.feature || 'agent_edit',
          language: row.language || null,
          loc_added_sum: row.loc_added_sum ?? row.loc_added ?? row.added_lines ?? row.additions,
          loc_deleted_sum: row.loc_deleted_sum ?? row.loc_deleted ?? row.deleted_lines ?? row.deletions,
          loc_suggested_to_add_sum: row.loc_suggested_to_add_sum ?? row.suggested_lines ?? 0
        }];
    return {
      ...row,
      repo: scope.repo,
      sprint_id: scope.sprint,
      source: row.source || 'edit_provenance',
      exact: true,
      pr_number: row.pr_number ?? row.pull_number ?? row.pull_request_number ?? null,
      commit_sha: row.commit_sha || row.sha || null,
      user_id: row.user_id || row.user || row.actor || 'unknown',
      totals_by_feature: features
    };
  });
}

function summarizeAiProvenanceRows(rows = []) {
  return rows.map(row => {
    const features = flattenCopilotFeatureMetrics(row);
    return {
      repo: row.repo,
      sprint_id: row.sprint_id,
      pr_number: row.pr_number,
      commit_sha: row.commit_sha,
      user_id: row.user_id,
      source: row.source,
      exact: true,
      ai_loc_added: features.reduce((sum, feature) => sum + feature.loc_added_sum, 0),
      ai_loc_deleted: features.reduce((sum, feature) => sum + feature.loc_deleted_sum, 0),
      ai_loc_suggested: features.reduce((sum, feature) => sum + feature.loc_suggested_to_add_sum, 0),
      features: features.map(feature => feature.feature)
    };
  });
}

function makeAiKey(repo, sprintId) {
  return `${repo || 'unknown'}::${sprintId || 'unassigned'}`;
}

function splitAiKey(key) {
  const [repo, sprintId] = key.split('::');
  return [repo, sprintId];
}

function emptyAiAggregate(repo = 'unknown', sprintId = 'unassigned') {
  return {
    repo,
    sprint_id: sprintId,
    ai_loc_added: 0,
    ai_loc_deleted: 0,
    ai_loc_suggested: 0,
    total_loc_added: 0,
    total_loc_deleted: 0,
    pr_count: 0,
    by_feature: {},
    numerator_sources: {},
    exact_ai_attribution: false,
    provenance_rows: 0,
    pr_numbers: new Set(),
    commit_shas: new Set()
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function summarizeAiUsage(records) {
  const totals = records.reduce((acc, record) => {
    acc.ai_loc_added += record.ai_loc_added;
    acc.ai_loc_deleted += record.ai_loc_deleted;
    acc.ai_loc_suggested += record.ai_loc_suggested;
    acc.total_loc_added += record.total_loc_added;
    acc.total_loc_deleted += record.total_loc_deleted;
    acc.pr_count += record.pr_count;
    return acc;
  }, emptyAiAggregate('all', 'all'));
  const totalLoc = totals.total_loc_added + totals.total_loc_deleted;
  const aiLoc = totals.ai_loc_added + totals.ai_loc_deleted;
  const rawPct = totalLoc > 0 ? aiLoc * 100 / totalLoc : null;
  return {
    pr_count: totals.pr_count,
    ai_loc_added: totals.ai_loc_added,
    ai_loc_deleted: totals.ai_loc_deleted,
    ai_loc_changed: aiLoc,
    ai_loc_suggested: totals.ai_loc_suggested,
    total_loc_added: totals.total_loc_added,
    total_loc_deleted: totals.total_loc_deleted,
    total_loc_changed: totalLoc,
    ai_usage_pct: rawPct === null ? null : round(clamp(rawPct, 0, 100), 1),
    raw_ai_usage_pct: rawPct === null ? null : round(rawPct, 1),
    pct_clamped: rawPct !== null && rawPct > 100,
    exact_ai_records: records.filter(record => record.exact_ai_attribution).length
  };
}

function buildDashboardModel(options = {}) {
  const data = loadData(options);
  const lifecycleRecords = buildLifecycleRecords({ webhooks: data.webhooks, pullRequests: data.pullRequests, config: data.config });
  const agentInvocations = normalizeAgentInvocations(data.otelRecords);
  const aiUsage = buildAiUsageRecords({ copilotUsageRows: data.copilotUsageRows, aiProvenanceRows: data.aiProvenanceRows, lifecycleRecords, config: data.config });

  return {
    generated_at: new Date().toISOString(),
    config: data.config,
    sources: {
      webhooks: data.webhooks.length,
      pull_requests: data.pullRequests.length,
      copilot_usage_rows: data.copilotUsageRows.length,
      ai_provenance_rows: data.aiProvenanceRows.length,
      enterprise_reports: data.enterpriseReports.length,
      otel_records: data.otelRecords.length,
      include_sample_data: data.includeSampleData,
      data_mode: data.includeSampleData ? 'sample_plus_runtime' : 'runtime_only'
    },
    lifecycle: {
      summary: summarizeLifecycle(lifecycleRecords, data.enterpriseReports),
      records: lifecycleRecords
    },
    agents: {
      summary: summarizeAgents(agentInvocations),
      invocations: agentInvocations
    },
    ai_usage: aiUsage,
    caveats: [
      'Cycle-time KPIs count merged PRs only. Closed-unmerged PRs are tracked separately and excluded from merge frequency.',
      'Historical branch creation can be exact only if GitHub Enterprise audit-log Git events or a retained audit-log stream contain the branch ref creation; otherwise use first-commit or PR-created fallback.',
      'Exact Copilot lines per PR/commit require edit-time provenance from the agent/editor or official Copilot LoC telemetry; GitHub PR diffs alone only provide the total changed-line denominator.',
      'Live custom-agent traces require runtime instrumentation through OTel or a direct simplified trace emitter; PRs, commits, and bot authorship can only infer activity.',
      'Webhook signature verification is intentionally omitted in this local demo server.'
    ]
  };
}

module.exports = {
  AGENT_FEATURES,
  ATTRIBUTE_KEYS,
  buildAiUsageRecords,
  buildDashboardModel,
  buildLifecycleRecords,
  flattenOtelRecords,
  loadData,
  normalizeAiProvenanceRows,
  normalizeAgentInvocations,
  normalizeRepoIdentifier,
  normalizeWebhookRecord,
  percentile,
  resolveSprint,
  summarizeAgents,
  summarizeAiUsage,
  summarizeLifecycle
};
