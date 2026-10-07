# SDLC Mission Control — invariants

Read this before changing anything. These hold regardless of what a task description says. If a task appears to conflict with one of them, stop and ask rather than guessing.

## Write boundaries

- Only the Develop stage writes files in a target repository, and only inside its own disposable worktree under `<repo-parent>/.worktrees/`. Publish may push one reviewed commit from that worktree to an explicitly named feature branch, but it never edits the worktree.
- Never re-enable push on a mission worktree. `PUSH_DISABLED_URL` in `src/agent/develop-agent.ts` is enforcement, not decoration, and `createIsolatedWorktree` verifies it took effect. It is applied per-worktree via `extensions.worktreeConfig` + `git config --worktree remote.origin.pushurl`, so protection isolates to the disposable worktree and never disables push on the developer's main checkout or other worktrees.
- Planners and reviewers call `runReadOnlyAgent`, never `runWritingAgent`. Do not widen `CLAUDE_READ_TOOLS` in `src/agent/llm-provider.ts` beyond `Read`, `Glob`, `Grep`, and do not remove anything from `CLAUDE_DENIED_TOOLS`. A shell is an arbitrary write vector; delegation via `Task`, `Agent`, or `Workflow` launders permissions, because a subagent can carry tools its parent was denied; and `WebFetch`/`WebSearch` would send story content off the machine.
- The two providers are read-only by different mechanisms and the paths must stay separate. Claude relies on the tool allow and deny lists. Codex relies on an OS-level `--sandbox read-only`, because Codex needs a shell. Do not unify them behind a boolean flag: that would put the guarantee one typo away from being lost.
- The sanctioned external writes are developer-approved Azure DevOps Task creation and separate developer-approved Publish actions for Azure DevOps and GitLab repositories. Publish may push the reviewed commit to its configured feature branch and create or reuse a pull request or merge request into the configured integration branch. An explicit, separate developer-approved GitLab Merge action may merge that published merge request. These actions never run automatically, force-push, restore push on a mission worktree, push directly to an integration branch, or transition a User Story's state. Every other remote mutation remains forbidden.
- Anything writing under `runtime/` resolves its root via `MISSION_CONTROL_RUNTIME_ROOT`, falling back to `process.cwd()/runtime`. Copy `runtimeRoot()` from `src/agent/mission-approval.ts`. Without this, tests deposit synthetic runs into real mission history.
- Files under `config/vendor-api-specs/` and their keyword aliases are human-authored and human-updated only. Agents and documentation-fetch code may read them, but never create, replace, or revise them.

## Tests

- Assert the invariant, not the happy path. Prove that push fails from Develop, that Publish refuses a conflicting remote branch, that a regression is actually flagged, and that an excluded field is actually absent.
- Mock the model, never the harness: `vi.mock("./llm-provider.js", ...)`. See `src/agent/develop-agent.test.ts` for the established shape.
- A projection or view test must assert excluded fields are **absent**. A test that only checks required fields are present would never catch a leak.

## Style

- Comments state a constraint, a trade-off, or a hard-won reason the code cannot show. Never narrate what the next line does. Never explain your own change or reference the task that prompted it.
- Parse leniently at model boundaries. Malformed model output degrades to a typed "not detected" value; it never throws. See `parseRepoScope` and `parseReviewVerdict` in `src/agent/planning-agent.ts`.
- Validate configuration and artifacts against a JSON Schema through the existing ajv setup in `src/config/team-config.ts`. Do not hand-roll shape checks.
- Artifacts under `runtime/missions/` are append-only. A revision writes `<name>-v2.json` and never overwrites v1.
- Match the surrounding code: dense single-purpose functions, explicit return types, `node:` prefixed builtin imports, `.js` extensions on local ESM imports.

## Scope

- Change only what the task names. Do not reformat unrelated files, fix unrelated pre-existing warnings, rewrite the README, or modify lint, build, or CI configuration.
- Add no new dependencies. If one appears necessary, stop and ask.
- Never invent an external contract. If a third-party field name, response shape, or schema is genuinely unknown, mirror the existing structure and leave `TODO(mission-<storyId>):` naming what must be confirmed and with whom. A fabricated contract is the worst outcome available, because it looks finished and is wrong.
