---

name: Direct Telemetry Reviewer
description: Review code while emitting direct custom-agent telemetry to the cloud dashboard.

hooks:
  SessionStart:

    - type: command
      command: "node scripts/vscode-agent-telemetry-hook.js"
      windows: "node scripts\\vscode-agent-telemetry-hook.js"
      timeout: 10
      env:
        VSCODE\_AGENT\_TELEMETRY\_AGENT: "Direct Telemetry Reviewer"
        OTEL\_TRACE\_URL: https://bbva-observatory.azurewebsites.net/otel/v1/traces
  PostToolUse:
    - type: command
      command: "node scripts/vscode-agent-telemetry-hook.js"
      windows: "node scripts\\vscode-agent-telemetry-hook.js"
      timeout: 10
      env:
        VSCODE\_AGENT\_TELEMETRY\_AGENT: "Direct Telemetry Reviewer"
        OTEL\_TRACE\_URL: https://bbva-observatory.azurewebsites.net/otel/v1/traces
  Stop:
    - type: command
      command: "node scripts/vscode-agent-telemetry-hook.js"
      windows: "node scripts\\vscode-agent-telemetry-hook.js"
      timeout: 20
      env:
        VSCODE\_AGENT\_TELEMETRY\_AGENT: "Direct Telemetry Reviewer"
        OTEL\_TRACE\_URL: https://bbva-observatory.azurewebsites.net/otel/v1/traces

---

# Direct telemetry reviewer

You are a code review agent for this workspace. Focus on correctness, test coverage, security issues, and whether the implementation matches the user's request.