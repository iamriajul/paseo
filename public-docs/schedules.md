---
title: Schedules
description: Run fresh agents on cron schedules or wake an existing agent with a heartbeat.
nav: Overview
order: 25
category: Schedules
---

# Schedules

A schedule starts a new agent for you on a cron cadence: at this time, run this prompt, in this repo, with these agent settings.

Paseo also has **heartbeats**. A heartbeat sends a recurring prompt back into one existing agent so it can reassess and continue the same conversation.

Both concepts use the same cron engine, but their product surfaces stay separate:

- **Schedules** create a new agent each run. You can inspect, pause, resume, run once, update, or delete them.
- **Heartbeats** target one existing agent. They are intentionally lightweight: create or delete them over MCP; from the CLI you can also update only their cron period.

Cron is the canonical cadence. The CLI accepts simple presets such as `5m` or `1h`, but compiles them to cron rather than storing a separate interval type.

Both run on a cadence you set. To start an agent from an external event instead — a comment, a mention — see [Hub](/docs/hub).

## What it's for

- **Fresh recurring jobs:** start a clean agent for daily triage, reports, or maintenance.
- **Heartbeats:** have the current agent periodically reassess state and keep moving.
- **Build babysitting:** keep one agent checking CI, EAS, Docker, or release builds until they pass.
- **Daily triage:** scan issues, PRs, and failing checks every morning.
- **Maintenance sweeps:** refresh dependencies, audit docs, or clean stale branches.

## Ways to create one

- **In the app** — open the Schedules view and create one with agent settings, a cron cadence, a repo, and a prompt. This is the main way to create and manage schedules.
- **[From chat](/docs/schedules-chat)** — ask the agent in a chat and it sets the schedule up for you.
- **[From the CLI](/docs/schedules-cli)** — `paseo schedule create`, for headless boxes and scripts.
- **[Over MCP](/docs/mcp)** — agents create and manage schedules programmatically.

## Keep run workspaces

Each new-agent schedule run creates a workspace. **Archive on finish** is on by default: when the run ends, Paseo archives that workspace and its agent. With worktree isolation, archiving also removes the worktree after its last active workspace is archived.

To keep runs available, open the schedule in the app's Schedules view, turn off **Archive on finish**, and save. Paseo keeps each run's workspace and agent active until you archive them; runs that fail before creating an agent are still cleaned up. This option also applies to local isolation; archiving a local workspace leaves the project directory in place.

The stored option is `target.config.archiveOnFinish`, a boolean that defaults to `true` when omitted. The CLI and MCP schedule tools do not expose this option; use the app to change it. Heartbeats use an existing agent and do not have this option.

## Skip while a previous run is active

Turn on **Skip while previous run is active** when a run must not start while the last one still needs you, for example a nightly job whose agent you keep open until you have reviewed it. The option is off by default.

While it is on, a trigger finds out whether an earlier run of this schedule is still active. For a new-agent schedule, a run is active while the agent it created is running or not yet archived; with **Archive on finish** on, that is until the run's workspace is archived. A skipped trigger starts nothing: Paseo writes a run with a `skipReason` to the schedule's logs (back-to-back skips share one entry, with a `skipCount` and the first and latest skip times), shows "Skipped … previous run still active" on the schedule's row, and waits for the next trigger as usual. A skipped trigger does not count toward **Max runs**. **Run now** is never skipped.

The check reads the archive state from agent storage, so it still holds after the daemon restarts. A heartbeat (a schedule that prompts an existing agent) has no runs of its own to wait for; with the option on, its trigger is skipped while that agent is in the middle of a turn.

Set it in the schedule form, with `--skip-while-active` / `--no-skip-while-active` on `paseo schedule create` and `paseo schedule update`, or with `skipWhileActive` on the `create_schedule`, `update_schedule` and `create_heartbeat` MCP tools. The stored field is `skipWhileActive`. It needs a host that advertises `server_info.features.scheduleSkipWhileActive`; the app hides the switch for older hosts.
