'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'data', 'runtime', 'github-webhooks.ndjson');

function usage() {
  console.error(`Usage:
  node scripts/import-github-audit-log.js --input audit-log.json --out data/runtime/github-webhooks.ndjson
  node scripts/import-github-audit-log.js --enterprise ENTERPRISE --repo OWNER/REPO --since YYYY-MM-DD

Options:
  --input FILE          JSON, slurped JSON, or NDJSON audit-log export.
  --enterprise NAME     Fetch enterprise audit-log Git events with gh api.
  --repo OWNER/REPO     Optional repo filter for enterprise fetch or input import.
  --since YYYY-MM-DD    Optional created:>= filter for enterprise fetch.
  --out FILE            Output NDJSON file. Defaults to data/runtime/github-webhooks.ndjson.
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

function readAuditLog(args) {
  if (args.input) return fs.readFileSync(path.resolve(args.input), 'utf8');
  if (!args.enterprise) throw new Error('Provide --input or --enterprise.');

  const phrase = [
    'action:git.create',
    args.repo ? `repo:${args.repo}` : null,
    args.since ? `created:>=${args.since}` : null
  ].filter(Boolean).join(' ');
  const endpoint = `/enterprises/${encodeURIComponent(args.enterprise)}/audit-log?include=git&per_page=100&phrase=${encodeURIComponent(phrase)}`;
  const result = spawnSync('gh', ['api', endpoint, '--paginate', '--slurp'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh api failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseAuditEvents(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    return flattenJsonEvents(parsed);
  }
  return trimmed.split(/\r?\n/).map(line => JSON.parse(line));
}

function flattenJsonEvents(value) {
  if (!Array.isArray(value)) return [value];
  return value.flatMap(item => Array.isArray(item) ? flattenJsonEvents(item) : [item]);
}

function normalizeRepo(value) {
  if (!value) return null;
  if (typeof value === 'object') return value.full_name || value.name || value.repo || null;
  return String(value).replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
}

function eventTimestampToIso(value) {
  if (!value && value !== 0) return null;
  if (typeof value === 'number') {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function branchNameFromEvent(event) {
  const ref = event.ref || event.data?.ref || event.ref_name || event.data?.ref_name;
  const refType = event.ref_type || event.data?.ref_type || event.type || event.data?.type;
  if (refType && String(refType).toLowerCase() !== 'branch' && !String(ref).startsWith('refs/heads/')) return null;
  if (!ref) return null;
  const normalized = String(ref).replace(/^refs\/heads\//, '');
  if (!normalized || normalized.startsWith('refs/tags/')) return null;
  return normalized;
}

function normalizeAuditEvent(event, repoFilter) {
  if (!event || event.action !== 'git.create') return null;
  const repo = normalizeRepo(event.repo || event.repository || event.data?.repo || event.data?.repository);
  if (!repo || (repoFilter && repo.toLowerCase() !== repoFilter.toLowerCase())) return null;
  const branch = branchNameFromEvent(event);
  if (!branch) return null;
  const receivedAt = eventTimestampToIso(event['@timestamp'] || event.created_at || event.created);
  if (!receivedAt) return null;
  return {
    event: 'create',
    received_at: receivedAt,
    source: 'github_audit_log',
    payload: {
      ref: branch,
      ref_type: 'branch',
      repository: { full_name: repo },
      sender: { login: event.actor || event.user || 'unknown' }
    }
  };
}

function readExistingKeys(outPath) {
  if (!fs.existsSync(outPath)) return new Set();
  const keys = new Set();
  const lines = fs.readFileSync(outPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      keys.add(recordKey(record));
    } catch {
      // Keep importing new valid rows even if an old manual line is malformed.
    }
  }
  return keys;
}

function recordKey(record) {
  return [
    record.event,
    record.payload?.repository?.full_name,
    record.payload?.ref_type,
    record.payload?.ref,
    record.received_at
  ].join('::');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const events = parseAuditEvents(readAuditLog(args));
  const records = events.map(event => normalizeAuditEvent(event, args.repo)).filter(Boolean);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const existing = readExistingKeys(outPath);
  const newRecords = records.filter(record => !existing.has(recordKey(record)));
  if (newRecords.length) {
    fs.appendFileSync(outPath, `${newRecords.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  }
  console.log(JSON.stringify({
    scanned: events.length,
    branch_create_records: records.length,
    appended: newRecords.length,
    skipped_existing: records.length - newRecords.length,
    out: outPath
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(1);
  }
}
