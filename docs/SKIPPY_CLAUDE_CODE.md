# Skippy in Claude Code — the "everywhere" playbook

Project Skippy (the Claude **app** system prompt) gives Claude identity, doctrine, and live
Context Engine access. This is how the same powers come to **Claude Code**, in every session,
across repos. `def-flyers` is the reference install.

## Why it's per-repo (the constraint)

Claude Code on the web runs in an **ephemeral container** cloned fresh from the repo each
session. There is **no account-level memory or MCP config yet** — `~/.claude/CLAUDE.md` and
`~/.claude/settings.json` do **not** persist across web sessions. The only config that reliably
survives is **committed to the repo**: `CLAUDE.md`, `.claude/`, `.mcp.json`. So "everywhere" =
this bundle, committed into each Skippy-ecosystem repo. Treat the def-flyers bundle as the
canonical template.

## The bundle

| File | Purpose |
|---|---|
| `CLAUDE.md` | Project doc; `@import`s the Skippy identity at the top. |
| `.claude/skippy/identity.md` | **Portable** — persona + doctrine + non-secret IDs. Copy unchanged into other repos. |
| `.mcp.json` | Registers the `skippy-context` remote MCP server. |
| `.claude/settings.json` | Bash permission allowlist + a lightweight (opt-in-respecting) SessionStart health check. |
| `.claude/commands/sync.md` | `/sync` — the opt-in Context Engine fetch. |
| `.claude/commands/plan-persist.md` | `/plan-persist` — the artifact-dies-with-chat checklist. |

## Install into another repo

1. Copy `.claude/skippy/identity.md`, `.claude/commands/`, `.claude/settings.json`, and
   `.mcp.json` over **unchanged** (they're repo-agnostic).
2. In that repo's `CLAUDE.md`, add `@.claude/skippy/identity.md` near the top, then write the
   project-specific section below it.
3. Commit + push. The bundle is live the next time Claude Code opens that repo.

> Future option: when Anthropic ships account-level MCP/managed settings for web, the
> `skippy-context` server and identity can move there and the per-repo copy becomes optional.
> Until then, per-repo commit is the mechanism. (The org `ramonscottf/.github` repo already
> distributes the *Skippy Capture* workflow this way; the CLAUDE.md bundle is the memory analog.)

## Environment setup (one-time, per Claude Code web environment)

The `skippy-context` MCP server authenticates with a bearer token. Define it as an environment
variable in the Claude Code **web environment** settings (claude.ai/code → environment), so
`.mcp.json`'s `${SKIPPY_CONTEXT_TOKEN}` resolves:

```
SKIPPY_CONTEXT_TOKEN = <token the omi worker accepts>
```

If the omi `/mcp` route is left open / read-only, drop the `headers` block from `.mcp.json` and
no token is needed. Note: web-environment env vars are visible to anyone with environment-config
access — scope the token to read-only retrieval.

## The MCP server (lives in skippy-omi)

The `skippy-context` server is a `/mcp` route added to the `skippy-omi` worker. A PR-ready
patch set is in [`skippy-omi-mcp/`](./skippy-omi-mcp/) — **apply it in the `ramonscottf/skippy-omi`
repo**, not here (one repo per worker; never two sessions pushing the same repo). After deploy,
verify with `claude mcp list` and a `smart_search` for a known commit ID.
