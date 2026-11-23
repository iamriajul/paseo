# Quotes and side questions

Two ways to refer back to a chat without copy-paste and without disturbing the agent's work.

- A **quote** puts a message, or a selected part of one, into the composer as a card. It is sent with the next prompt so the agent sees which passage you mean.
- A **side question** asks about the conversation in a separate, read-only session forked from it. The agent in the main chat never sees the question or the answer, and keeps working while you ask.

Both ship on web, Electron, iOS and Android. Quote needs nothing from the host. Side questions need `server_info.features.sideQuestions` and a provider that reports `supportsNativeFork`; today that is Claude. The proofs are in [fork-decisions.md](fork-decisions.md#side-questions).

## Quote

### Where the action lives

| Surface                         | Web and desktop                                                | iOS and Android                                    |
| ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Assistant turn footer           | Quote button beside Copy and Fork                              | Same button, always visible                        |
| User message actions            | Quote button beside Rewind and Copy, on hover                  | Same button, always visible                        |
| Text selection inside a message | Floating toolbar above the selection: **Quote**, **Ask aside** | Two items in the native selection menu, after Copy |

The footer button quotes the whole message. The selection actions quote the selected text. On native, `quotes/native-selection-items.ts` passes `contextMenuItems` to the Markdown library's text view. Code blocks and tables are separate native views without those items, so quote them with the footer button. The web toolbar (`quotes/selection-toolbar.web.tsx`) reads the selection through the same code that builds the copy clipboard, so a quoted selection is the Markdown a copy would produce.

### In the composer

A quote is a card above the input: a source line ("Agent" or "You", plus "selection" for a partial quote), the text clamped to two lines, and a remove button. Several quotes stack in the order added; the same passage twice keeps one card. Pressing the source line scrolls the chat to the quoted message. A quote is a composer attachment of kind `quote`, so it persists with the draft, and a prompt may consist of quotes alone.

### What the agent receives

The app serializes quotes into the prompt text, ahead of what the user typed. There is no quote attachment in the protocol.

```
> [Quoted from your earlier reply]
> The old session keys are discarded on purpose.

Why discard them instead of rotating?
```

The header line is one of three fixed strings:

- `[Quoted from your earlier reply]`
- `[Quoted from my earlier message]`
- `[Quoted from your answer to a side question. That exchange is not in this conversation.]`

Text was chosen over a new `AgentAttachment` member because provider history is the durable transcript: after a daemon restart or an import, every provider hands attachments back as plain text, so a structured quote would survive only until the first rehydration. Text also needs no protocol change and no feature gate.

`quotes/quote-format.ts` holds the serializer and the parser. The user bubble parses leading blocks of that exact shape back into quote cards and shows the rest as the message. The three header strings stay out of i18n: they are wire format read by the agent.

A quote from the same conversation is capped at 4,000 characters; a longer one keeps its head and tail around a `[…]` line, because the agent already holds the full message. A quote from a side question is sent whole, because the main agent has never seen it.

## Side question

### Where the action lives

| Entry point                                       | Opens                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Button in the composer's trailing controls        | An empty side question at the latest point                                                     |
| `/btw <question>` typed in the composer           | The same, with the question sent                                                               |
| **Ask aside** on a text selection                 | A side question at the latest point with the selection quoted                                  |
| Side-question button on the latest assistant turn | An empty side question at the latest point                                                     |
| The same button on an earlier assistant turn      | A menu: **Ask about this reply** (latest point, that reply quoted) and **Ask from this point** |
| **Side questions** pill above the composer        | The list of this chat's side questions; pressing one reopens it                                |

"Ask about this reply" is the default for earlier turns because it reads the whole prompt cache. "Ask from this point" is for the case where the agent must not know what came later, and it costs more: see [Cache](#cache).

### Where it opens

- **Split-pane layouts:** in the [side pane](explorer-sidebar.md#side-pane), through `openWorkspaceTargetBeside`. The main chat stays visible and usable.
- **Compact layouts:** in a [sheet](explorer-sidebar.md#sheets). The `agent` panel manifest gives a side question a `compactSheet` rule without Open as tab. Unlike a subagent sheet, this sheet keeps its composer.

A side question is an `agent` tab whose agent carries the side-question label. `AgentPanel` renders it with these differences:

- Header: the title "Side question" and a **Read-only** badge. The menu holds **Continue as a full session** and **Archive**.
- A line under the header: "Sees _chat title_ up to the latest reply" (or "an earlier reply"). Pressing it opens the main chat. While the main agent is running, the line adds "the agent keeps working".
- Composer: text, quotes and images only (`inputMode: "side_question"` in `composer/input-mode.ts`). No model, mode, thinking, feature or attachment controls, no voice, no autocomplete, no queueing: a question sent mid-answer replaces the answer.
- A cost line under the composer before each send, and a usage line on each answer. See [Cost](#cost).
- Each answer's footer has **Quote in main chat**, and a selection inside the pane offers **Quote** (into the side composer) and **Quote in main chat**.
- No rewind, no fork menu, no subagents track.

### The session behind it

A side question is a native fork of the main agent's Claude session, registered as its own agent in the same workspace with the label `paseo.side-question-of=<source agent id>`. It also carries `paseo.side-question-point` (`latest` or `earlier`) and, for an earlier point, `paseo.side-question-boundary-at`, which the cost estimate reads.

`agent.side_question.open.request` / `.response` takes the source agent id and an optional boundary (the same `boundaryMessageId` / `boundaryCursor` pair as `agent.native_fork.request`) and returns the new agent id. Follow-ups use the normal prompt RPC. `AgentManager.openSideQuestion` forks the transcript through the SDK's `forkSession` over the file on disk, with no boundary for the latest point and `upToMessageId` for an earlier one. Both read the transcript, so a fork works while the source's turn is running or waiting on a permission. The fork is a real session with its own id, so it registers like any native fork.

`buildSideQuestionConfig` copies every launch option that shapes the request prefix (model, effort, thinking, system prompt, settings, tool policy, cache TTL) and sets the source's `sessionAffinityId`, so a gateway routes the fork to the account that holds the cache. The side question starts no MCP servers and runs with `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, for the reasons recorded under `claude-prompt-cache-warming` in [fork-decisions.md](fork-decisions.md): deferred MCP tool names already sit in the transcript, and a resumed process would otherwise append every changed instruction file to the prompt.

The system prompt cannot say "this is a side question" without breaking the cache, so the daemon puts a notice in a `paseo-system` envelope ahead of the first prompt (`agent-messages/side-question-notice.ts`, applied in `sendPromptToAgent` while the agent has no user message). The notice says:

- this is a side question on a copy of the conversation, and the main session continues separately and will not see this exchange;
- answer the question and do not continue the task;
- reading and searching are available, and every tool that changes files, runs commands or contacts other agents is blocked.

The timeline shows the user's own text. `projectAgentMessages` strips the notice from the live echo and from replay alike.

### Read-only is enforced by the daemon

The envelope is advice. These are the controls, all on the daemon:

1. **A `PreToolUse` hook denies every tool that is not on an allowlist.** The allowlist is `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch` and `ToolSearch` (`providers/claude/side-question-policy.ts`). Everything else is denied with the message "Side questions are read-only.", including `Bash`, `Edit`, `Write`, `NotebookEdit`, `Agent`, `Skill`, every MCP tool, and any tool added later. A hook runs before permission rules, so `bypassPermissions` and a user's `permissions.allow` entries cannot let a tool through.
2. **`canUseTool` denies the same set**, as a second layer. An allowed tool goes on to the session's normal permission flow, so a read outside the project still asks.
3. **The mode is locked.** The session launches in `default` mode without the bypass capability, and `AgentManager` rejects mode, model, thinking, feature and reload-with-overrides changes for an agent carrying the side-question label, whichever RPC or MCP tool asks.
4. **No MCP servers start**, so the Paseo tools that create or message agents do not exist in the session.
5. **User and project hooks, file checkpointing, cache warm-up, auto-compaction and restart recovery are off** for the session.

Tools are denied at call time rather than removed with `disallowedTools`: removing a tool changes the tool definitions, which sit at the front of the prompt, and the whole cache would be rewritten.

Plan mode is not used. It asks the agent for a plan and an `ExitPlanMode` approval, and it leaves the decision to permission prompts. `Bash` is denied outright rather than filtered for read-only commands: no command filter is reliable, and the agent can answer most questions from its context plus `Read` and `Grep`.

A denied tool call fails with the message above, and the pane shows a callout offering **Continue as a full session**. That is an ordinary native fork of the side question into a new tab with the main chat's mode, tools and launch options (`AgentManager.buildNativeForkLaunch`).

### Cache

A side question reads the main session's prompt cache when all of these hold:

| Condition                               | Why                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Same model                              | A cache belongs to one model. The side question has no model picker.                                           |
| Same system prompt and tool definitions | They are the front of the prefix. Launch options are copied from the source and tools are denied, not removed. |
| Same gateway account                    | `sessionAffinityId` names the root session on every request.                                                   |
| The cache is still alive                | The 5 minute or 1 hour window since the main session's last request.                                           |
| The fork point has a cache entry        | Entries exist only where a request ended. See below.                                                           |

Anthropic writes one cache entry per breakpoint, at the end of a request's prefix, and a later request finds it only by walking back at most 20 blocks from its own breakpoint. A read restarts the window of the entry it read and no other. So:

- **Latest point:** the fork's prefix ends where the main session's last request ended. It reads everything. `agent.side-question.local.e2e.test.ts` runs Claude Code against a stub of the Messages API and checks that the fork's first request carries the source's system prompt, tools and whole history as its front, and names the source's session in `X-Claude-Code-Session-Id`.
- **Earlier point:** the entry written when that turn ended lives for one window after that turn and is not refreshed by later turns. Forking there reads the cache only if that turn ended inside the current window; otherwise the fork rewrites everything up to that point at the cache-write price. This follows from Anthropic's documented rules and has not been measured against the real API: the stub checks which history the fork sends, not what Anthropic bills. Measure it with the logging stub used for the warm-up fork before trusting the estimate for earlier points.

A follow-up in the same side question reads the side session's own entry, which lives for one window after its last answer.

### Cost

Before each send, the line under the side composer states what the question will do. The daemon computes it from the source agent's `promptCache` record and the effective cache window (`agent.side_question.estimate.request`, `estimateSideQuestionCache`), and the app refreshes it every 20 seconds and after each answer:

- "Cache warm. Reads 412k cached tokens." in the muted colour.
- "Cache expired 12 min ago. This question rewrites 412k tokens." in the warning colour, and the send button reads **Ask anyway**.
- "Earlier point, outside the cache window. Rewrites about 180k tokens." in the warning colour, with **Ask anyway**.

After each answer, the footer shows the tokens its requests read and wrote, from the request journal. The Side questions list shows each question's cost where Claude Code reported one. A side question's usage is not added to the main agent's context meter or cache insights. Its first request is measured against the source's last request, as a native fork's is.

### Bringing an answer back

Nothing reaches the main chat on its own. **Quote in main chat** adds the answer, or the selection, to the main composer as a quote card marked "Side question". On send it uses the third header string, so the main agent knows it has not seen that exchange. On compact layouts the action also closes the sheet.

### Afterwards

- Closing the pane or sheet keeps the side question. Its process stops after five idle minutes (`idleAfterMs` on the runtime cleanup candidate, in force whether or not `agents.idleRuntimeCleanup` is on); a follow-up resumes the session. An empty side question that was never sent is archived when its pane closes.
- The **Side questions** pill sits in the composer track bar of the main agent while it has at least one. Its list shows each question's first line, answer count, cost and fork point, and offers **Archive all**. A dot on the pill marks an answer that arrived while its pane was closed.
- Side questions are archived with the main agent, like subagents.
- They are left out of the sidebar, History, the workspace status bucket, the attention picker, auto-opened tabs and push notifications. The label does this, not `internal`: an internal agent is hidden from listings the list needs. A side question keeps its own attention state, which drives the pill's dot.
