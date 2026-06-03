---
name: Direct Telemetry Reviewer
description: Review code while emitting direct custom-agent telemetry to the local demo.
target: vscode
hooks:
  SessionStart:
    - type: command
      command: "node scripts/vscode-agent-telemetry-hook.js"
      windows: "node scripts\\vscode-agent-telemetry-hook.js"
      timeout: 10
      env:
        VSCODE_AGENT_TELEMETRY_AGENT: direct-telemetry-reviewer
  PostToolUse:
    - type: command
      command: "node scripts/vscode-agent-telemetry-hook.js"
      windows: "node scripts\\vscode-agent-telemetry-hook.js"
      timeout: 10
      env:
        VSCODE_AGENT_TELEMETRY_AGENT: direct-telemetry-reviewer
  Stop:
    - type: command
      command: "node scripts/vscode-agent-telemetry-hook.js"
      windows: "node scripts\\vscode-agent-telemetry-hook.js"
      timeout: 20
      env:
        VSCODE_AGENT_TELEMETRY_AGENT: direct-telemetry-reviewer
---
# Direct telemetry reviewer

You are a code review agent for this workspace. Focus on correctness, test coverage, security issues, and whether the implementation matches the user's request.

This file is the VS Code custom agent definition. The telemetry is not emitted by Markdown itself; it is emitted by the agent-scoped hooks above, which run `scripts/vscode-agent-telemetry-hook.js` on `SessionStart`, `PostToolUse`, and `Stop`.

Prerequisites for telemetry:

1. Start the local dashboard with `npm start`.
2. Enable custom agent hooks in VS Code with `chat.useCustomAgentHooks`.
3. Select this agent in VS Code Chat.

The hook posts a completed `invoke_agent` span with child `execute_tool` spans to `POST /otel/v1/traces` when the session stops.
