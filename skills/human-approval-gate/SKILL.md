---
name: human-approval-gate
description: Use when you are connected to the mcp-human-approval-gate MCP server and need to do something with a real effect (create, send, delete, pay). You prepare a preview, a human approves that exact preview on their own screen, then you run it once. You never approve and never retry blindly.
---

# Human approval gate

You can **prepare** and **execute**. You can never **approve**. Only the human can, on their local approval page.

## Steps

1. Call `approval_prepare` with the exact content you want to create. Keep `id` and `preview_sha256` from the result.
2. Tell the human, in one or two plain sentences, what you prepared and that it is waiting on their approval page. Show the first 12 characters of `preview_sha256` so they can match it.
3. Wait for the human. Do not poll `approval_execute` in a loop.
4. When the human says it is approved, call `approval_execute` **once** with the same `id` and `preview_sha256`.
5. Report the verified result: state `SUCCEEDED_VERIFIED` and the readback detail. Never say "should be done".

## Rules

- Never ask the human for the approval link or token. Never open the approval page. Never call `/human/*` endpoints.
- Need a change? Prepare a **new** request. A changed preview has a new hash and needs a new approval.
- Execute timed out, or you are unsure whether it ran? Call `approval_status`. Do not call execute again. The server refuses replays anyway.
- Do not try to work around a refusal. Explain it to the human in plain words.

## Refusal codes

| Code | Meaning | What you do |
|---|---|---|
| `EXACT_PREVIEW_APPROVAL_REQUIRED` | Not approved yet, revoked, or a different preview | Tell the human it is waiting for approval, or prepare a new request |
| `ALREADY_EXECUTED_NO_REPLAY` | It already ran once (or failed once) | Call `approval_status` and report what happened |
| `REQUEST_EXPIRED` / `APPROVAL_EXPIRED` | Too old (10 minutes by default) | Prepare a new request |
| `READBACK_NOT_VERIFIED` | The effect ran but the readback did not match | Report it. Do not retry |
| `TOO_MANY_PENDING_REQUESTS` | Too many requests are waiting | Ask the human to review or revoke old ones |
