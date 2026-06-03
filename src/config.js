'use strict';

const ATTRIBUTE_KEYS = Object.freeze({
  operationName: ['gen_ai.operation.name'],
  agentName: ['gen_ai.agent.name', 'agent.name', 'github.copilot.agent.name'],
  agentType: ['github.copilot.agent.type', 'copilot.agent.type', 'agent.type'],
  executingUser: ['enduser.id', 'user.id', 'github.user', 'github.actor', 'user.login', 'executing_user'],
  teamId: ['team.id', 'github.team', 'team.slug', 'department'],
  repository: ['github.copilot.git.repository', 'copilot_chat.repo.remote_url', 'repository', 'repo'],
  branch: ['github.copilot.git.branch', 'copilot_chat.repo.head_branch_name', 'branch'],
  commitSha: ['github.copilot.git.commit_sha', 'copilot_chat.repo.head_commit_hash', 'commit_sha'],
  inputTokens: ['gen_ai.usage.input_tokens', 'input_tokens'],
  outputTokens: ['gen_ai.usage.output_tokens', 'output_tokens'],
  model: ['gen_ai.response.model', 'gen_ai.request.model', 'model'],
  toolName: ['gen_ai.tool.name', 'tool.name'],
  errorType: ['error.type']
});

const AGENT_FEATURES = Object.freeze([
  'agent_edit',
  'chat_panel_agent_mode',
  'chat_panel_custom_mode'
]);

module.exports = {
  ATTRIBUTE_KEYS,
  AGENT_FEATURES
};
