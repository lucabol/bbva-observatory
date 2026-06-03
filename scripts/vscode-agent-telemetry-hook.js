'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TRACE_URL = process.env.OTEL_TRACE_URL || 'https://bbva-observatory.azurewebsites.net/otel/v1/traces';
const STATE_DIR = process.env.VSCODE_AGENT_TELEMETRY_STATE_DIR || path.join(os.tmpdir(), 'bbva-vscode-agent-telemetry');

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

function parseHookInput(text) {
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function hex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function safeId(value) {
  return String(value || 'unknown-session').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `${safeId(sessionId)}.json`);
}

function readState(sessionId) {
  const filePath = statePath(sessionId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeState(sessionId, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(sessionId), JSON.stringify(state, null, 2), 'utf8');
}

function removeState(sessionId) {
  const filePath = statePath(sessionId);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function normalizeRepo(cwd) {
  const base = path.basename(cwd || process.cwd()) || 'workspace';
  return `local/${base}`;
}

function startSession(input) {
  const sessionId = input.sessionId || input.session_id || hex(6);
  writeState(sessionId, {
    sessionId,
    traceId: hex(16),
    rootSpanId: hex(8),
    startedAt: input.timestamp || new Date().toISOString(),
    cwd: input.cwd || process.cwd(),
    tools: []
  });
  return { continue: true, systemMessage: 'Direct telemetry hook initialized for this agent session.' };
}

function recordTool(input) {
  const sessionId = input.sessionId || input.session_id;
  if (!sessionId) return { continue: true };
  const state = readState(sessionId) || {
    sessionId,
    traceId: hex(16),
    rootSpanId: hex(8),
    startedAt: input.timestamp || new Date().toISOString(),
    cwd: input.cwd || process.cwd(),
    tools: []
  };
  state.tools.push({
    toolName: input.tool_name || input.toolName || 'unknown_tool',
    toolUseId: input.tool_use_id || input.toolUseId || null,
    timestamp: input.timestamp || new Date().toISOString()
  });
  writeState(sessionId, state);
  return { continue: true };
}

async function stopSession(input) {
  const sessionId = input.sessionId || input.session_id || hex(6);
  const state = readState(sessionId) || {
    sessionId,
    traceId: hex(16),
    rootSpanId: hex(8),
    startedAt: input.timestamp || new Date().toISOString(),
    cwd: input.cwd || process.cwd(),
    tools: []
  };
  const stoppedAt = input.timestamp || new Date().toISOString();
  const agentName = process.env.VSCODE_AGENT_TELEMETRY_AGENT || 'vscode-direct-telemetry-agent';
  const user = process.env.GITHUB_USER || process.env.USERNAME || process.env.USER || 'unknown';
  const repo = process.env.GITHUB_REPOSITORY || normalizeRepo(state.cwd);
  const branch = process.env.GITHUB_BRANCH || 'vscode-agent-session';
  const spans = [{
    trace_id: state.traceId,
    span_id: state.rootSpanId,
    name: `invoke_agent ${agentName}`,
    start_time: state.startedAt,
    end_time: stoppedAt,
    resource_attributes: {
      'service.name': agentName,
      'session.id': sessionId,
      'github.user': user,
      'team.id': process.env.TEAM_ID || 'unknown'
    },
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': agentName,
      'github.copilot.agent.type': 'custom',
      'github.copilot.git.repository': repo,
      'github.copilot.git.branch': branch,
      'agent.telemetry.source': 'vscode-agent-hook',
      'agent.telemetry.hook_event': 'Stop'
    },
    status_code: 'OK'
  }];

  state.tools.forEach((tool, index) => {
    const startedAt = new Date(new Date(tool.timestamp).getTime() || Date.now());
    const endedAt = new Date(startedAt.getTime() + 1);
    spans.push({
      trace_id: state.traceId,
      span_id: hex(8),
      parent_span_id: state.rootSpanId,
      name: `execute_tool ${tool.toolName}`,
      start_time: startedAt.toISOString(),
      end_time: endedAt.toISOString(),
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': tool.toolName,
        'gen_ai.tool.type': 'vscode-agent-tool',
        'agent.telemetry.tool_use_id': tool.toolUseId
      },
      status_code: 'OK'
    });
  });

  if (process.env.OTEL_TRACE_DRY_RUN === '1') {
    removeState(sessionId);
    return { continue: true, telemetry: { dry_run: true, accepted_spans: spans.length, payload: { spans } } };
  }

  const result = await postTrace({ spans });
  removeState(sessionId);
  return { continue: true, systemMessage: `Direct telemetry sent ${result.accepted_spans || spans.length} span(s) for this agent session.` };
}

async function postTrace(payload) {
  const response = await fetch(DEFAULT_TRACE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Trace endpoint returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const input = parseHookInput(await readStdin());
  const event = input.hookEventName || input.hook_event_name || input.event || 'Unknown';
  let output;
  if (event === 'SessionStart') {
    output = startSession(input);
  } else if (event === 'PostToolUse') {
    output = recordTool(input);
  } else if (event === 'Stop') {
    output = await stopSession(input);
  } else {
    output = { continue: true };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  parseHookInput,
  recordTool,
  startSession,
  stopSession
};
