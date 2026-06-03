'use strict';

const crypto = require('node:crypto');

const DEFAULT_TRACE_URL = process.env.OTEL_TRACE_URL || 'http://localhost:3000/otel/v1/traces';

function usage() {
  console.error(`Usage:
  node scripts/sample-custom-agent.js --user USER --repo OWNER/REPO --branch feature/x
  node scripts/sample-custom-agent.js --dry-run --agent payment-reviewer --prompt "Review this PR"

Options:
  --url URL            Trace endpoint. Defaults to ${DEFAULT_TRACE_URL}.
  --agent NAME         Custom agent name. Defaults to sample-direct-telemetry-agent.
  --version VERSION    Agent version. Defaults to 1.0.0-demo.
  --user LOGIN         Executing user.
  --team TEAM          Team id. Defaults to demo.
  --repo OWNER/REPO    Repository.
  --branch BRANCH      Branch or refs/heads/BRANCH.
  --commit SHA         Optional current commit SHA.
  --pr NUMBER          Optional pull request number.
  --model MODEL        Model name. Defaults to gpt-5.5.
  --prompt TEXT        Simulated prompt. Only prompt length is logged.
  --dry-run            Print the trace payload instead of posting it.
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

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizeBranch(branch) {
  return String(branch || 'feature/sample-direct-telemetry').replace(/^refs\/heads\//, '');
}

class DirectTraceLogger {
  constructor(options = {}) {
    this.url = options.url || DEFAULT_TRACE_URL;
    this.dryRun = Boolean(options.dryRun);
    this.spans = [];
  }

  startInvocation(options = {}) {
    const traceId = hex(16);
    const spanId = hex(8);
    const startedAt = new Date();
    const context = { traceId, rootSpanId: spanId, startedAt };
    this.rootSpan = {
      trace_id: traceId,
      span_id: spanId,
      name: `invoke_agent ${options.agentName}`,
      start_time: startedAt.toISOString(),
      resource_attributes: {
        'service.name': options.agentName,
        'service.version': options.agentVersion,
        'github.user': options.user,
        'team.id': options.team,
        'session.id': options.sessionId
      },
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': options.agentName,
        'gen_ai.agent.version': options.agentVersion,
        'github.copilot.agent.type': 'custom',
        'github.copilot.git.repository': options.repo,
        'github.copilot.git.branch': options.branch,
        'github.copilot.git.commit_sha': options.commit || null,
        'github.copilot.pull_request.number': options.prNumber || null,
        'gen_ai.request.model': options.model,
        'gen_ai.response.model': options.model,
        'gen_ai.usage.input_tokens': 0,
        'gen_ai.usage.output_tokens': 0,
        'agent.sample.direct_telemetry': true,
        'agent.sample.prompt_length': options.promptLength
      },
      status_code: 'UNSET'
    };
    return context;
  }

  recordChildSpan(context, options = {}) {
    this.spans.push({
      trace_id: context.traceId,
      span_id: hex(8),
      parent_span_id: context.rootSpanId,
      name: options.name,
      start_time: options.startedAt.toISOString(),
      end_time: options.endedAt.toISOString(),
      attributes: options.attributes || {},
      status_code: options.statusCode || 'OK'
    });
  }

  finishInvocation(statusCode, usage = {}) {
    this.rootSpan.end_time = new Date().toISOString();
    this.rootSpan.status_code = statusCode || 'OK';
    this.rootSpan.attributes['gen_ai.usage.input_tokens'] = usage.inputTokens || 0;
    this.rootSpan.attributes['gen_ai.usage.output_tokens'] = usage.outputTokens || 0;
    this.spans.unshift(this.rootSpan);
  }

  async flush() {
    const payload = { spans: this.spans };
    if (this.dryRun) {
      return { dry_run: true, accepted_spans: this.spans.length, payload };
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Trace endpoint returned ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }
}

class SampleCustomAgent {
  constructor(options = {}) {
    this.agentName = options.agentName || 'sample-direct-telemetry-agent';
    this.agentVersion = options.agentVersion || '1.0.0-demo';
    this.user = options.user || 'unknown';
    this.team = options.team || 'demo';
    this.repo = options.repo || 'OWNER/REPO';
    this.branch = normalizeBranch(options.branch);
    this.commit = options.commit || null;
    this.prNumber = options.prNumber || null;
    this.model = options.model || 'gpt-5.5';
    this.prompt = options.prompt || 'Review the pull request and run the project checks.';
    this.logger = options.logger;
  }

  async run() {
    const context = this.logger.startInvocation({
      agentName: this.agentName,
      agentVersion: this.agentVersion,
      user: this.user,
      team: this.team,
      repo: this.repo,
      branch: this.branch,
      commit: this.commit,
      prNumber: this.prNumber,
      model: this.model,
      sessionId: `sample-agent-${hex(4)}`,
      promptLength: this.prompt.length
    });

    const usage = { inputTokens: 0, outputTokens: 0 };
    try {
      await this.simulateModelCall(context, usage);
      await this.simulateToolCall(context, 'readFile', 120, { 'agent.sample.files_read': 3 });
      await this.simulateToolCall(context, 'edit', 180, { 'agent.sample.files_changed': 1 });
      await this.simulateToolCall(context, 'runTests', 220, { 'agent.sample.tests_run': 11 });
      this.logger.finishInvocation('OK', usage);
    } catch (error) {
      this.logger.finishInvocation('ERROR', usage);
      throw error;
    }

    return this.logger.flush();
  }

  async simulateModelCall(context, usage) {
    const startedAt = new Date();
    await sleep(150);
    const endedAt = new Date();
    usage.inputTokens += 1250;
    usage.outputTokens += 320;
    this.logger.recordChildSpan(context, {
      name: `chat ${this.model}`,
      startedAt,
      endedAt,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': this.model,
        'gen_ai.response.model': this.model,
        'gen_ai.usage.input_tokens': 1250,
        'gen_ai.usage.output_tokens': 320,
        'agent.sample.prompt_logged': false
      }
    });
  }

  async simulateToolCall(context, toolName, durationMillis, extraAttributes = {}) {
    const startedAt = new Date();
    await sleep(durationMillis);
    const endedAt = new Date();
    this.logger.recordChildSpan(context, {
      name: `execute_tool ${toolName}`,
      startedAt,
      endedAt,
      attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': toolName,
        'gen_ai.tool.type': 'function',
        ...extraAttributes
      }
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const logger = new DirectTraceLogger({
    url: args.url || DEFAULT_TRACE_URL,
    dryRun: args['dry-run']
  });
  const agent = new SampleCustomAgent({
    agentName: args.agent,
    agentVersion: args.version,
    user: args.user,
    team: args.team,
    repo: args.repo,
    branch: args.branch,
    commit: args.commit,
    prNumber: args.pr,
    model: args.model,
    prompt: args.prompt,
    logger
  });
  const result = await agent.run();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    usage();
    process.exit(1);
  });
}

module.exports = {
  DirectTraceLogger,
  SampleCustomAgent,
  parseArgs
};
