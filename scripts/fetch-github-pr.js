#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const [owner, repo, pullNumber] = process.argv.slice(2);
if (!owner || !repo || !pullNumber) {
  console.error('Usage: node scripts/fetch-github-pr.js OWNER REPO PULL_NUMBER');
  process.exit(1);
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const runtimeDir = process.env.RUNTIME_DIR || path.resolve(__dirname, '..', 'data', 'runtime');
const outputFile = path.join(runtimeDir, 'github-pull-requests.json');

function githubGet(apiPath) {
  const options = {
    hostname: 'api.github.com',
    path: apiPath,
    method: 'GET',
    headers: {
      'user-agent': 'sprint-ai-flow-observatory-demo',
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  };

  return new Promise((resolve, reject) => {
    const request = https.request(options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub API ${response.statusCode}: ${text}`));
          return;
        }
        resolve(JSON.parse(text));
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  const pr = await githubGet(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
  const commits = await githubGet(`/repos/${owner}/${repo}/pulls/${pullNumber}/commits?per_page=100`);
  const normalized = {
    repo: `${owner}/${repo}`,
    number: pr.number,
    title: pr.title,
    head_ref: pr.head?.ref,
    base_ref: pr.base?.ref,
    user_login: pr.user?.login,
    created_at: pr.created_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at,
    merged: Boolean(pr.merged_at),
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    labels: (pr.labels || []).map(label => label.name),
    milestone: pr.milestone?.title || null,
    commits: commits.map(commit => ({
      sha: commit.sha,
      committed_at: commit.commit?.committer?.date || commit.commit?.author?.date
    }))
  };

  fs.mkdirSync(runtimeDir, { recursive: true });
  const existing = fs.existsSync(outputFile) ? JSON.parse(fs.readFileSync(outputFile, 'utf8') || '[]') : [];
  const filtered = existing.filter(item => !(item.repo === normalized.repo && Number(item.number) === Number(normalized.number)));
  filtered.push(normalized);
  fs.writeFileSync(outputFile, JSON.stringify(filtered, null, 2), 'utf8');
  console.log(`Saved ${normalized.repo}#${normalized.number} to ${outputFile}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
