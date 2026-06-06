---
description: Opt-in pull from the Skippy Context Engine (omi.fosterlabs.org)
argument-hint: [topic or query — what to catch up on]
---

Pull cross-project context from the Skippy Context Engine. This is the **opt-in** fetch — only
run when invoked. Do not auto-fetch context outside of this command.

Query: **$ARGUMENTS** (if empty, ask Scott what to sync on, or summarize the index via `index`).

Steps:
1. Pick the right tool by query shape:
   - IDs, dates, GitHub commits, iMessage content → `skippy-context` MCP **`smart_search`**
     (endpoint `/context/v2/smart`).
   - Natural-language / "catch me up" synthesis → **`nl_search`** (`/context/smart`).
   - Recent texts ("this week", a referenced message) → **`imsg_recent`** (`/context/imsg`) —
     apply the sensitive-content handling from the identity doc.
   - Raw top-k with metadata → **`raw_search`**.
2. If the `skippy-context` MCP server is unavailable, fall back to curl (allowlisted), always
   substituting the real query — never send a brace/placeholder:
   ```bash
   curl -s -G "https://omi.fosterlabs.org/context/v2/smart" --data-urlencode "q=$ARGUMENTS"
   ```
3. Summarize what's relevant to the task at hand — don't dump raw hits. Cite IDs/dates/commits.
