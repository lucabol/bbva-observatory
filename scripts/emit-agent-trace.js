'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = process.env.OTEL_TRACE_URL || 'https://bbva-observatory.azurewebsites.net/otel/v1/traces';

function usage() {
  console.error(`Usage:
  node scripts/emit-agent-trace.js --agent payment-reviewer --user USER --repo OWNER/REPO --branch feature/x --tools readFile,edit,test
  node scripts/emit-agent-trace.js --input trace.json --url https://bbva-observatory.azurewebsites.net/otel/v1/traces

Options:
  --agent NAME          Agent name for generated invoke_agent span.
  --user LOGIN         Executing user.
  --team TEAM          Team id.
  --repo OWNER/REPO    Repository.
  --branch BRANCH      Branch or refs/heads/BRANCH.
  --commit SHA         Optional current commit SHA.
  --model MODEL        Optional model name.
  --tools CSV          Tool names to emit as child execute_tool spans.
  --running            Leave root span open to show a live running session.
  --input FILE         Send an existing JSON trace payload instead of generating one.
  --url URL            Trace endpoint. Defaults to ${DEFAULT_URL}.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function hex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function isoOffset(baseMillis, offsetMillis) {
  return new Date(baseMillis + offsetMillis).toISOString();
}

function generatedTrace(args) {
  const traceId = hex(16);
  const rootSpanId = hex(8);
  const startMillis = Date.now() - 45_000;
  const tools = String(args.tools || 'readFile,edit')
    .split(',')
    .map(tool => tool.trim())
    .filter(Boolean);
  const root = {
    trace_id: traceId,
    span_id: rootSpanId,
    name: `invoke_agent ${args.agent || 'custom-agent'}`,
    start_time: isoOffset(startMillis, 0),
    end_time: args.running ? undefined : isoOffset(startMillis, 40_000),
    resource_attributes: {
      'github.user': args.user || 'unknown',
      'team.id': args.team || 'unknown'
    },
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': args.agent || 'custom-agent',
      'github.copilot.agent.type': 'custom',
      'github.copilot.git.repository': args.repo || null,
      'github.copilot.git.branch': args.branch || null,
      'github.copilot.git.commit_sha': args.commit || null,
      'gen_ai.request.model': args.model || 'unknown',
      'gen_ai.usage.input_tokens': Number(args.input_tokens || 0),
      'gen_ai.usage.output_tokens': Number(args.output_tokens || 0)
    },
    status_code: args.running ? undefined : 'OK'
  };
  const spans = [root];
  tools.forEach((tool, index) => {
    spans.push({
      trace_id: traceId,
      span_id: hex(8),
      parent_span_id: rootSpanId,
      name: `execute_tool ${tool}`,
      start_time: isoOffset(startMillis, 5_000 + index * 5_000),
      end_time: isoOffset(startMillis, 7_500 + index * 5_000),
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': tool,
        'gen_ai.tool.type': 'function'
      },
      status_code: 'OK'
    });
  });
  return { spans };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Trace endpoint returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const payload = args.input
    ? JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'))
    : generatedTrace(args);
  const result = await postJson(args.url || DEFAULT_URL, payload);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    usage();
    process.exit(1);
  });
}
