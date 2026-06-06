---
description: Run the Skippy plan-persistence checklist before ending a session/handoff
---

Enforce the **artifact-dies-with-chat** rule. A plan the next session can't find doesn't exist.
Work this checklist now and report each item's status (don't claim done without verifying):

1. **Written** — the plan exists as markdown in the right repo (project repo, or
   `ramonscottf/skippy-plans` for cross-project plans).
2. **Committed + pushed** — run `git status` / `git log` and confirm the push **succeeded** to the
   correct branch. A local-only commit does not count.
3. **Indexed** — referenced in the README / plans index table with the **correct status** (not
   "in progress" if it's done).
4. **Parents updated** — any parent plan's frontmatter/headers reflect this plan's new state.
5. **Docs match reality (PROMPT-IS-A-DOC-TOO)** — if infra changed, every doc that a change made
   false (READMEs, CLAUDE.md, `.claude/skippy/identity.md`, the system prompt) is updated this
   session. If a doc contradicts reality, fix it **before** new work.

If any item fails, fix it before ending the turn. Report the final state plainly.
