---
title: 定时任务
description: 按 cron 计划运行新的 Agent，或用 heartbeat 唤醒已有的 Agent。
nav: 概览
---

# 定时任务 {#schedules}

定时任务按 cron 节奏为你启动一个新的 Agent：在这个时间，在这个仓库里，用这些 Agent 设置运行这段提示词。

Paseo 还有 **heartbeat**。heartbeat 会定期向一个已有的 Agent 发送提示词，让它重新评估并继续同一段对话。

两者使用同一个 cron 引擎，但在产品中是分开的：

- **定时任务**每次运行都会创建一个新的 Agent。你可以查看、暂停、恢复、运行一次、更新或删除它们。
- **heartbeat** 针对一个已有的 Agent，刻意保持轻量：通过 MCP 创建或删除；在 CLI 中还可以只更新它们的 cron 周期。

cron 是标准的节奏表示。CLI 接受 `5m` 或 `1h` 这样的简单预设，但会把它们编译成 cron，而不是另存一种间隔类型。

两者都按你设定的节奏运行。如果想由外部事件（比如一条评论或一次提及）启动 Agent，请参见 [Hub](/docs/hub)。

## 用途 {#what-its-for}

- **全新的周期性任务**：为每日分拣、报告或维护启动一个干净的 Agent。
- **heartbeat**：让当前 Agent 定期重新评估状态并继续推进。
- **盯构建**：让一个 Agent 持续检查 CI、EAS、Docker 或发布构建，直到通过。
- **每日分拣**：每天早上扫描 issue、PR 和失败的检查。
- **维护巡检**：更新依赖、审核文档或清理过期分支。

## 创建方式 {#ways-to-create-one}

- **在应用中**：打开定时任务视图，设置 Agent、cron 节奏、仓库和提示词来创建。这是创建和管理定时任务的主要方式。
- **[在聊天中](/docs/schedules-chat)**：在聊天中告诉 Agent，它会为你创建定时任务。
- **[通过 CLI](/docs/schedules-cli)**：`paseo schedule create`，适用于无界面的机器和脚本。
- **[通过 MCP](/docs/mcp)**：Agent 以编程方式创建和管理定时任务。

## 保留运行工作区 {#keep-run-workspaces}

新建 Agent 的定时任务每次运行都会创建一个工作区。**Archive on finish** 默认开启：运行结束时，Paseo 会归档该工作区及其 Agent。使用 worktree 隔离时，最后一个使用该 worktree 的活跃工作区被归档后，归档还会删除这个 worktree。

要保留运行结果，在应用的定时任务视图中打开该定时任务，关闭 **Archive on finish** 并保存。Paseo 会让每次运行的工作区和 Agent 保持活跃，直到你手动归档；在创建 Agent 之前就失败的运行仍会被清理。该选项同样适用于本地隔离；归档本地工作区不会删除项目目录。

存储的选项是 `target.config.archiveOnFinish`，一个布尔值，省略时默认为 `true`。CLI 和 MCP 的定时任务工具不提供这个选项；请在应用中修改。heartbeat 使用已有的 Agent，没有这个选项。

## 上一次运行仍活跃时跳过 {#skip-while-a-previous-run-is-active}

如果上一次运行仍需要你处理时不应开始新的运行，请打开 **Skip while previous run is active**，例如你会让夜间任务的 Agent 保持打开直到审阅完毕。该选项默认关闭。

开启后，每次触发都会检查该定时任务之前的运行是否仍然活跃。对于新建 Agent 的定时任务，只要某次运行创建的 Agent 仍在运行或尚未归档，该运行就算活跃；开启 **Archive on finish** 时，即直到该运行的工作区被归档。被跳过的触发不会启动任何内容：Paseo 会在定时任务日志中写入一条带 `skipReason` 的运行记录（连续的跳过共用一条记录，带有 `skipCount` 以及首次和最近一次跳过的时间），在定时任务行上显示 "Skipped … previous run still active"，并照常等待下一次触发。被跳过的触发不计入 **Max runs**。**Run now** 永远不会被跳过。

该检查从 Agent 存储读取归档状态，因此守护进程重启后依然有效。heartbeat（提示已有 Agent 的定时任务）没有需要等待的独立运行；开启该选项后，当该 Agent 正在执行一轮对话时，触发会被跳过。

可以在定时任务表单中设置，也可以在 `paseo schedule create` 和 `paseo schedule update` 上使用 `--skip-while-active` / `--no-skip-while-active`，或在 MCP 工具 `create_schedule`、`update_schedule` 和 `create_heartbeat` 上使用 `skipWhileActive`。存储的字段是 `skipWhileActive`。它需要宿主声明 `server_info.features.scheduleSkipWhileActive`；对较旧的宿主，应用会隐藏该开关。
