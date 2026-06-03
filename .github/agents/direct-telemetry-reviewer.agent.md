---

name: Direct Telemetry Reviewer
description: Review code while emitting direct custom-agent telemetry to the cloud dashboard.
target: github-copilot

hooks:
  SessionStart:

    - type: command
      command: "node scripts/vscode-agent-telemetry-hook.js"
      windows: "node scripts\\vscode-agent-telemetry-hook.js"
      timeout: 10
      env:
        VSCODE\_AGENT\_TELEMETRY\_AGENT: direct-telemetry-reviewer
        OTEL\_TRACE\_URL: https://bbva-observatory.azurewebsites.net/otel/v1/traces
  PostToolUse:
    - type: command
      command: "node scripts/vscode-agent-telemetry-hook.js"
      windows: "node scripts\\vscode-agent-telemetry-hook.js"
      timeout: 10
      env:
        VSCODE\_AGENT\_TELEMETRY\_AGENT: direct-telemetry-reviewer
        OTEL\_TRACE\_URL: https://bbva-observatory.azurewebsites.net/otel/v1/traces
  Stop:
    - type: command
      command: "node scripts/vscode-agent-telemetry-hook.js"
      windows: "node scripts\\vscode-agent-telemetry-hook.js"
      timeout: 20
      env:
        VSCODE\_AGENT\_TELEMETRY\_AGENT: direct-telemetry-reviewer
        OTEL\_TRACE\_URL: https://bbva-observatory.azurewebsites.net/otel/v1/traces

---

# Direct telemetry reviewer

You are a code review agent for this workspace. Focus on correctness, test coverage, security issues, and whether the implementation matches the user''s request.

This file is the VS Code custom agent definition. The telemetry is not emitted by Markdown itself; it is emitted by the agent-scoped hooks above, which run `scripts/vscode-agent-telemetry-hook.js` on `SessionStart`, `PostToolUse`, and `Stop`.

Prerequisites for telemetry:

1. Make sure the cloud dashboard is reachable at `https://bbva-observatory.azurewebsites.net`.
2. Enable custom agent hooks in VS Code with `chat.useCustomAgentHooks`.
3. Select this agent in VS Code Chat.

The hook posts a completed `invoke_agent` span with child `execute_tool` spans to `https://bbva-observatory.azurewebsites.net/otel/v1/traces` when the session stops.