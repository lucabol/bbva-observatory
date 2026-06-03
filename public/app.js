'use strict';

const state = { model: null };
const GITHUB_TOKEN_STORAGE_KEY = 'sprintAiFlow.githubToken';
const GITHUB_SETTINGS_STORAGE_KEY = 'sprintAiFlow.githubSettings';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function fmtPct(value) {
  return value === null || value === undefined ? 'n/a' : `${fmtNumber(value)}%`;
}

function fmtValue(value) {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  return fmtNumber(value);
}

function fmtDate(value) {
  if (!value) return 'n/a';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function statusBadge(status) {
  const klass = status === 'merged' || status === 'ok' ? 'ok' : status === 'running' || status === 'closed_unmerged' ? 'warn' : status === 'error' ? 'err' : '';
  return `<span class="badge ${klass}">${escapeHtml(status)}</span>`;
}

function card(label, value, hint = '') {
  return `<article class="card"><div class="label">${label}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</article>`;
}

function renderTable(selector, headers, rows) {
  const table = $(selector);
  table.innerHTML = `<thead><tr>${headers.map(header => `<th>${escapeHtml(header.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map(header => `<td>${header.render ? header.render(row) : escapeHtml(row[header.key] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

function renderBars(selector, rows, labelKey, valueKey, formatter = fmtNumber) {
  const max = Math.max(1, ...rows.map(row => Number(row[valueKey]) || 0));
  $(selector).innerHTML = rows.length ? rows.map(row => {
    const value = Number(row[valueKey]) || 0;
    const width = Math.max(2, value * 100 / max);
    return `<div class="bar-row"><strong>${escapeHtml(row[labelKey])}</strong><div class="track"><div class="fill" style="width:${width}%"></div></div><span>${formatter(value)}</span></div>`;
  }).join('') : '<p class="status">No records yet.</p>';
}

function renderLifecycle(model) {
  const summary = model.lifecycle.summary;
  $('#lifecycleCards').innerHTML = [
    card('Merged PRs', fmtNumber(summary.merged_pull_requests), 'Closed-unmerged PRs are excluded'),
    card('Median cycle time', `${fmtNumber(summary.median_cycle_time_hours)}h`, 'Branch/first commit to merge'),
    card('P85 cycle time', `${fmtNumber(summary.p85_cycle_time_hours)}h`),
    card('Exact branch starts', fmtPct(summary.exact_branch_start_pct), 'Create webhook coverage'),
    card('Copilot PR median', `${fmtNumber(summary.copilot_pr_metrics.median_minutes_to_merge_copilot_authored)}m`, 'From Copilot usage metrics')
  ].join('');

  renderTable('#lifecycleTable', [
    { label: 'PR', render: row => `#${escapeHtml(row.pr_number)}<br><strong>${escapeHtml(row.title)}</strong>` },
    { label: 'Sprint', key: 'sprint_id' },
    { label: 'Status', render: row => statusBadge(row.status) },
    { label: 'Start source', render: row => `<span class="badge">${row.start_source}</span>` },
    { label: 'Cycle start', render: row => fmtDate(row.cycle_start_at) },
    { label: 'Merged at', render: row => fmtDate(row.pr_merged_at) },
    { label: 'Cycle time', render: row => row.cycle_time_hours === null ? 'excluded' : `${fmtNumber(row.cycle_time_hours)}h` },
    { label: 'Changed lines', render: row => `${fmtNumber(row.total_changed_lines)} (${fmtNumber(row.additions)}+ / ${fmtNumber(row.deletions)}-)` }
  ], model.lifecycle.records);
}

function renderAgents(model) {
  const summary = model.agents.summary;
  $('#agentCards').innerHTML = [
    card('Agent invocations', fmtNumber(summary.total_invocations)),
    card('Active sessions', fmtNumber(summary.active_sessions)),
    card('Custom invocations', fmtNumber(summary.custom_invocations)),
    card('Unique users', fmtNumber(summary.unique_users)),
    card('Output tokens', fmtNumber(summary.total_output_tokens)),
    card('P95 duration', `${fmtNumber(summary.p95_duration_ms)}ms`)
  ].join('');

  renderBars('#agentBars', summary.top_agents, 'agent_name', 'invocations');
  renderTable('#agentTable', [
    { label: 'Agent', render: row => `<strong>${escapeHtml(row.agent_name)}</strong><br><span class="badge">${escapeHtml(row.agent_type)}</span>` },
    { label: 'User / team', render: row => `${escapeHtml(row.executing_user)}<br><span class="badge">${escapeHtml(row.team_id)}</span>` },
    { label: 'Status', render: row => statusBadge(row.status) },
    { label: 'Repo / branch', render: row => `${escapeHtml(row.repo || 'n/a')}<br>${escapeHtml(row.branch || 'n/a')}` },
    { label: 'Tools', render: row => `${fmtNumber(row.tool_calls)}<br>${escapeHtml(row.tools.join(', '))}` },
    { label: 'Tokens', render: row => `${fmtNumber(row.input_tokens)} in / ${fmtNumber(row.output_tokens)} out` },
    { label: 'Started', render: row => fmtDate(row.started_at) },
    { label: 'Duration', render: row => row.duration_ms === null ? 'n/a' : `${fmtNumber(row.duration_ms)}ms` }
  ], model.agents.invocations);
}

function renderAi(model) {
  const summary = model.ai_usage.summary;
  $('#aiCards').innerHTML = [
    card('AI changed LoC', fmtNumber(summary.ai_loc_changed), `${fmtNumber(summary.ai_loc_added)} added / ${fmtNumber(summary.ai_loc_deleted)} deleted`),
    card('Total changed LoC', fmtNumber(summary.total_loc_changed), `${fmtNumber(summary.total_loc_added)} added / ${fmtNumber(summary.total_loc_deleted)} deleted`),
    card('AI usage', fmtPct(summary.ai_usage_pct), summary.pct_clamped ? 'Raw value exceeded 100% and was clamped' : 'Directional metric'),
    card('AI suggested LoC', fmtNumber(summary.ai_loc_suggested)),
    card('Merged PRs covered', fmtNumber(summary.pr_count)),
    card('Exact AI records', fmtNumber(summary.exact_ai_records || 0), 'Edit-time provenance')
  ].join('');

  const featureRows = model.ai_usage.by_feature.map(feature => ({
    feature: feature.feature,
    changed: feature.ai_loc_added + feature.ai_loc_deleted
  }));
  renderBars('#featureBars', featureRows, 'feature', 'changed');

  renderTable('#aiTable', [
    { label: 'Repo', key: 'repo' },
    { label: 'Sprint', key: 'sprint_id' },
    { label: 'PRs', key: 'pr_count' },
    { label: 'AI lines', render: row => `${fmtNumber(row.ai_loc_changed)} (${fmtNumber(row.ai_loc_added)}+ / ${fmtNumber(row.ai_loc_deleted)}-)` },
    { label: 'Total lines', render: row => `${fmtNumber(row.total_loc_changed)} (${fmtNumber(row.total_loc_added)}+ / ${fmtNumber(row.total_loc_deleted)}-)` },
    { label: 'AI usage', render: row => `${fmtPct(row.ai_usage_pct)}${row.pct_clamped ? '<br><span class="badge warn">clamped</span>' : ''}` },
    { label: 'Numerator source', render: row => `${escapeHtml(row.numerator_source || 'none')}${row.exact_ai_attribution ? '<br><span class="badge ok">exact</span>' : ''}` },
    { label: 'Granularity', key: 'granularity' }
  ], model.ai_usage.records);

  renderTable('#aiProvenanceTable', [
    { label: 'Repo', key: 'repo' },
    { label: 'Sprint', key: 'sprint_id' },
    { label: 'PR / commit', render: row => `#${escapeHtml(row.pr_number ?? 'n/a')}<br>${escapeHtml(row.commit_sha || 'n/a')}` },
    { label: 'User', key: 'user_id' },
    { label: 'AI lines', render: row => `${fmtNumber(row.ai_loc_added + row.ai_loc_deleted)} (${fmtNumber(row.ai_loc_added)}+ / ${fmtNumber(row.ai_loc_deleted)}-)` },
    { label: 'Features', render: row => escapeHtml(row.features.join(', ') || 'n/a') },
    { label: 'Source', render: row => `<span class="badge ok">${escapeHtml(row.source)}</span>` }
  ], model.ai_usage.provenance_records || []);
}

function renderData(model) {
  $('#sourceCards').innerHTML = Object.entries(model.sources).map(([key, value]) => card(key.replaceAll('_', ' '), fmtValue(value))).join('');
  $('#caveats').innerHTML = model.caveats.map(caveat => `<li>${caveat}</li>`).join('');
}

function githubSettingsFormValues() {
  return {
    org: $('#githubOrg').value.trim(),
    repositories: $('#githubRepos').value,
    includeOrgRepos: $('#includeOrgRepos').checked,
    includeCopilotMetrics: $('#includeCopilotMetrics').checked,
    attributeCopilotTo: $('#attributeCopilotTo').value.trim(),
    since: $('#githubSince').value || '',
    maxRepos: $('#githubMaxRepos').value || '20',
    maxPullRequestsPerRepo: $('#githubMaxPrs').value || '25',
    rememberToken: $('#rememberGithubToken').checked
  };
}

function persistGithubSettings() {
  localStorage.setItem(GITHUB_SETTINGS_STORAGE_KEY, JSON.stringify(githubSettingsFormValues()));
  const token = $('#githubToken').value.trim();
  if ($('#rememberGithubToken').checked && token) {
    localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
  }
}

function loadStoredGithubSettings() {
  const raw = localStorage.getItem(GITHUB_SETTINGS_STORAGE_KEY);
  if (raw) {
    try {
      const settings = JSON.parse(raw);
      $('#githubOrg').value = settings.org || '';
      $('#githubRepos').value = settings.repositories || '';
      $('#includeOrgRepos').checked = Boolean(settings.includeOrgRepos);
      $('#includeCopilotMetrics').checked = Boolean(settings.includeCopilotMetrics);
      $('#attributeCopilotTo').value = settings.attributeCopilotTo || '';
      $('#githubSince').value = settings.since || '';
      $('#githubMaxRepos').value = settings.maxRepos || '20';
      $('#githubMaxPrs').value = settings.maxPullRequestsPerRepo || '25';
      $('#rememberGithubToken').checked = Boolean(settings.rememberToken);
    } catch {
      localStorage.removeItem(GITHUB_SETTINGS_STORAGE_KEY);
      $('#settingsStatus').textContent = 'Saved GitHub settings were invalid and have been cleared.';
    }
  }

  const token = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY);
  if (token) {
    $('#githubToken').value = token;
    $('#rememberGithubToken').checked = true;
    $('#settingsStatus').textContent = 'Loaded saved GitHub token from this browser.';
  } else if (raw) {
    $('#settingsStatus').textContent = 'Loaded saved GitHub settings from this browser.';
  }
}

function persistGithubToken(token) {
  if ($('#rememberGithubToken').checked && token) {
    localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, token);
    return;
  }
  localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
}

function clearStoredGithubToken() {
  localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
  $('#githubToken').value = '';
  $('#rememberGithubToken').checked = false;
  persistGithubSettings();
  $('#settingsStatus').textContent = 'Saved GitHub token cleared from this browser.';
}

function bindGithubSettingsPersistence() {
  for (const selector of ['#githubOrg', '#githubRepos', '#attributeCopilotTo', '#githubSince', '#githubMaxRepos', '#githubMaxPrs']) {
    $(selector).addEventListener('input', persistGithubSettings);
  }
  $('#includeOrgRepos').addEventListener('change', persistGithubSettings);
  $('#includeCopilotMetrics').addEventListener('change', persistGithubSettings);
  $('#rememberGithubToken').addEventListener('change', persistGithubSettings);
  $('#githubToken').addEventListener('input', () => {
    if ($('#rememberGithubToken').checked) persistGithubSettings();
  });
}

async function syncGithubSettings(event) {
  event.preventDefault();
  const button = $('#githubSyncButton');
  const status = $('#settingsStatus');
  const token = $('#githubToken').value.trim();
  const payload = {
    token,
    org: $('#githubOrg').value.trim(),
    repositories: $('#githubRepos').value.trim(),
    includeOrgRepos: $('#includeOrgRepos').checked,
    includeCopilotMetrics: $('#includeCopilotMetrics').checked,
    attributeCopilotTo: $('#attributeCopilotTo').value.trim() || null,
    since: $('#githubSince').value || null,
    maxRepos: Number($('#githubMaxRepos').value || 20),
    maxPullRequestsPerRepo: Number($('#githubMaxPrs').value || 25)
  };
  button.disabled = true;
  status.textContent = 'Fetching live GitHub pull requests...';
  try {
    const response = await fetch('/api/settings/github-sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await readJsonResponse(response);
    if (!response.ok) {
      if (response.status === 405) {
        throw new Error('Settings API is not available in the running server. Stop the current npm start process and start it again, then retry.');
      }
      const error = new Error(result.error || `GitHub sync failed with HTTP ${response.status}`);
      error.status = response.status;
      error.details = result;
      throw error;
    }
    persistGithubToken(token);
    persistGithubSettings();
    if (!$('#rememberGithubToken').checked) $('#githubToken').value = '';
    status.textContent = JSON.stringify(result, null, 2);
    await loadModel();
  } catch (error) {
    status.textContent = formatGithubSyncError(error);
  } finally {
    button.disabled = false;
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: `The local server returned non-JSON ${response.status} ${response.statusText || ''}`.trim(),
      raw_response: text.slice(0, 1000)
    };
  }
}

function formatGithubSyncError(error) {
  if (error.name === 'TypeError' && /fetch|network|load/i.test(error.message || '')) {
    return [
      'Sync failed: the browser could not reach the local Settings API.',
      '',
      `Endpoint: ${window.location.origin}/api/settings/github-sync`,
      'What to try: make sure npm start is still running on this same port, then open /api/health and confirm it lists POST /api/settings/github-sync.',
      `Browser detail: ${error.message}`
    ].join('\n');
  }

  const details = error.details || {};
  const lines = [`Sync failed: ${error.message || details.error || 'Unknown error'}`];
  if (error.status || details.status) lines.push(`HTTP status: ${error.status || details.status}`);
  if (details.code) lines.push(`Code: ${details.code}`);
  if (details.hint) lines.push(`What to try: ${details.hint}`);
  if (details.context?.org) lines.push(`Organization: ${details.context.org}`);
  if (details.context?.repo) lines.push(`Repository: ${details.context.repo}`);
  if (details.github) {
    lines.push(`GitHub request: ${details.github.method || 'GET'} ${details.github.path || '(unknown path)'}`);
    if (details.github.request_id) lines.push(`GitHub request id: ${details.github.request_id}`);
    if (details.github.documentation_url) lines.push(`GitHub docs: ${details.github.documentation_url}`);
    const rate = details.github.rate_limit;
    if (rate?.remaining !== null && rate?.remaining !== undefined) {
      const reset = rate.reset ? new Date(Number(rate.reset) * 1000).toLocaleString() : 'unknown';
      lines.push(`Rate limit: ${rate.remaining}/${rate.limit || '?'} remaining; resets ${reset}`);
    }
  }
  if (details.raw_response) lines.push(`Raw response: ${details.raw_response}`);
  return lines.join('\n');
}

async function loadModel() {
  $('#status').textContent = 'Loading demo model...';
  const response = await fetch('/api/model', { cache: 'no-store' });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  state.model = await response.json();
  renderLifecycle(state.model);
  renderAgents(state.model);
  renderAi(state.model);
  renderData(state.model);
  $('#status').textContent = `Loaded ${state.model.sources.webhooks} webhooks, ${state.model.sources.otel_records} OTel records, and ${state.model.sources.copilot_usage_rows} Copilot usage rows. Generated ${fmtDate(state.model.generated_at)}.`;
}

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(item => item.classList.remove('active'));
    $$('.panel').forEach(item => item.classList.remove('active'));
    tab.classList.add('active');
    $(`#${tab.dataset.target}`).classList.add('active');
  });
});

$('#refresh').addEventListener('click', () => {
  loadModel().catch(error => {
    $('#status').textContent = `Failed to refresh: ${error.message}`;
  });
});

$('#githubSettingsForm').addEventListener('submit', event => {
  syncGithubSettings(event);
});

$('#clearGithubToken').addEventListener('click', () => {
  clearStoredGithubToken();
});

loadStoredGithubSettings();
bindGithubSettingsPersistence();

loadModel().catch(error => {
  $('#status').textContent = `Failed to load demo model: ${error.message}`;
});
