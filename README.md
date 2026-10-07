# SDLC Mission Control

Developer-controlled autonomous coding missions for Azure DevOps User Stories.

## Overview

Developers select an eligible User Story, select one allowed repository, review an AI-generated task plan, then explicitly approve creating ADO Task(s) from it.

The mission workflow is limited to User Stories in `New`, `Active`, and `Ready for Development`; it includes attachments and linked work items as context. Approval creates and links Task work items under the User Story — it never transitions the User Story's own state.

The read-only dashboard displays the team's requirements backlog — both User Stories and Spikes, in native ADO order. Developers can filter by Status and Assigned to before choosing a mission-eligible User Story.

## Planning and approval

Planning runs create a versioned Mission Packet in the ignored `runtime/` directory. It records the story context, selected repository baseline, detected repository commands, repository instructions, a small repository-specific planning skill, and a bounded list of likely files. The dashboard offers:

- **Provider**: run the planning agent on either the **Codex CLI** or the **Claude Code CLI**. Neither can modify files or call Azure DevOps, but they are constrained by different mechanisms:
  - Codex runs with `--sandbox read-only --ephemeral` — enforced by the operating system, so writes fail regardless of what the model attempts.
  - Claude runs with an allow list of `Read`/`Glob`/`Grep` plus an explicit deny list covering the write vectors (`Bash`, `Write`, `Edit`, `NotebookEdit`), delegation (`Task`, `Agent`, `Workflow` — a subagent could otherwise carry tools the parent was denied), and network egress (`WebFetch`, `WebSearch`). No shell is available, since a shell is an arbitrary write vector. The deny list is explicit because the allow list alone was observed not to remove every tool.

  In both cases enforcement is external to the model; the prompt's read-only instructions are a belt, not the braces.
- **Fast** planning: targeted files and no Git-history access by the agent.
- **Deep** planning: wider current-baseline source inspection, still read-only.
- **History policy**: no history, or bounded preflight-selected ancestor commit summaries. The planning agent never searches Git history itself.

A completed plan also names, in a structured (not just prose) form, any *other* configured repository the story may require changes in. This is a hypothesis for the developer to confirm or reject, not a decision the agent makes — the dashboard shows it as an editable repository-scope list before approval.

**Approval** creates one ADO Task per confirmed repository, linked as a child of the User Story, with a **dry-run toggle** that previews the exact Task title/description that would be created without ever calling Azure DevOps. This is the only write path anywhere in this dashboard.

Once Tasks are approved, a mission can continue past planning: a Develop agent implements the approved plan in an isolated git worktree, deterministic gates check scope/regressions/secrets, a critic judges the diff, and — once everything passes — a publish step pushes the commit and opens the pull request.

## Setup — first time on a new machine

### 1. Prerequisites

Install these before anything else:

- **Node.js** (any recent LTS) and npm.
- **Azure CLI** (`az`), plus the DevOps extension: `az extension add --name azure-devops`.
- **Claude Code CLI** (`claude`) and **Codex CLI** (`codex`) — both must be on your `PATH`. This app never calls the Anthropic or OpenAI APIs directly; every agent shells out to whichever of these two CLIs is on your machine, so each one needs to be installed and **logged into your own account** (`claude` handles its own login; run `codex login` for Codex) before any mission will run. There is no API key environment variable to set for either — if a CLI is not authenticated, the mission fails at that step with the CLI's own auth error, not a misleading one from this app.
- A local checkout of every repository you intend to run missions against, plus `git` on your `PATH`.

### 2. Configure `config/team-config.json`

Copy the example and fill in your own values:

```sh
cp config/team-config.example.json config/team-config.json
```

This file is **machine- and person-specific** and is gitignored — never commit it. Every repository entry's `localPath` must be an absolute path to where you have that repo checked out on your machine.

Set `team.taskPlanning.developerAlias` to your own alias — it is used to build feature branch names (`feature/{developer}/{workItemId}`).

Do not add tokens, PATs, or any credential to this file. Its whole purpose is repository and team topology.

### 3. Set your Azure DevOps PAT — read the permissions note below carefully

Export this in the shell that starts the dashboard (add it to your shell profile, do not hardcode it anywhere in the repo):

```sh
export AZURE_DEVOPS_EXT_PAT="<your PAT>"
```

This one token is used for two things: reading the team's backlog order (read-only), and everything the CLI performs on your behalf later in a mission — creating and linking Task work items, and pushing a commit and opening a pull request once a mission completes. It is read only from the environment at call time; this app never writes it to a config file, a log, or the `runtime/` audit trail.

**When you create the PAT in Azure DevOps, scope it to exactly:**

| Scope | Access | Why |
|---|---|---|
| Work Items | Read & write | Read the backlog; create and link Task work items under a User Story |
| Code | Read & write | Push a mission's commit and open its pull request |

**Do not grant anything beyond those two.** In particular:
- No `Full access` PAT. A broad token is a much larger blast radius than this tool ever needs, and every scope you skip is one this tool literally cannot misuse even if something upstream of it goes wrong.
- No Build, Release, Marketplace, Analytics, Graph, or other scopes — nothing here reads or touches them.
- **Set an expiration on it.** Treat it like any other credential you'd rotate, not a "set once, forget forever" value.
- If you ever suspect it leaked, revoke it in Azure DevOps immediately — this app holds no copy of it anywhere on disk to also clean up.

### 4. Verify the setup before running a real mission

```sh
npm install
npm run config:validate       # builds, then confirms team-config.json matches the schema and every localPath exists
npm run dev -- ado check      # confirms the PAT works and can see the configured team's area paths
```

Both should succeed cleanly before you open the dashboard. `config validate` catches a bad `localPath` or a schema mistake; `ado check` catches an under-scoped or expired PAT — better to find either at the command line than mid-mission.

### 5. Run it

```sh
npm run dashboard   # builds, fetches a fresh read-only backlog snapshot, and serves the local dashboard
```

Restart the dashboard to refresh that backlog snapshot. `npm run dev` runs the CLI directly (`config validate`, `ado check`, `ado backlog`, `ado item <id>`) without building or serving the UI, which is faster for iterating on backend changes alone.

Optional environment variables:
- `PORT` — dashboard port, defaults to `7421`.
- `MISSION_CONTROL_RUNTIME_ROOT` — where the `runtime/` audit trail (plans, develop runs, cost logs) is written. Defaults to `./runtime`. Only worth setting if you want mission history somewhere other than the repo checkout.
