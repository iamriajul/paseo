# Fork decisions

Every behaviour this fork changes inside official Paseo files, and the command that
proves each one still works.

The fork is a rebase queue: `main` is the upstream release tag we track, plus one
commit per change. The commits hold the code; this file holds the why and the proof.

After rebasing onto a new upstream release, run:

```bash
npm run fork:verify
```

That runs every command below and names any decision that did not survive the rebase.
`scripts/fork-verify.mjs` parses this file directly, so there is no second copy to keep
in sync — edit a decision here and the runner picks it up.

Changing an official file? Add a section here with a command that fails without your
change. A decision with no command is a decision nothing protects.

## claude-custom-context-window

**honor custom-model context window for auto-compact**

additionalModels/profile contextWindowMaxTokens is source of truth; set CLAUDE_CODE_MAX_CONTEXT_TOKENS and CLAUDE_CODE_AUTO_COMPACT_WINDOW with overwrite; match gateway-prefixed and case-insensitive ids; do not shrink the Paseo meter below the configured window

```bash
npx vitest run packages/server/src/server/agent/providers/claude/models.test.ts packages/server/src/server/agent/providers/claude/agent.env.test.ts --bail=1
```

## composer-track-pills

**fork tracks as composer pills**

ComposerTrackBar is shown when fork extra pills exist; AgentTracks renders heartbeats/background tasks as children. Schedules query key is host identity only.

v0.7.2 pulls host-connection (and `__DEV__`) into `use-schedules`. Root `npx vitest` does not apply the app config, so run the app files through the app workspace.

```bash
npx vitest run packages/protocol/src/background-tasks-schema.test.ts packages/protocol/src/provider-heartbeats-schema.test.ts --bail=1
npm test --workspace=@getpaseo/app -- src/panels/agent-tracks.test.ts src/heartbeats/track-presentation.test.ts src/background-tasks/track-presentation.test.ts src/hooks/use-schedules.test.ts --bail=1
```

## pdf-file-preview

**PDF files open in a built-in PDF panel**

v0.14.0 replaced the file pane's `FilePreviewBody` with a catalog of file panels (`packages/app/src/file-panels/`), and only plugins could claim binary files. The fork adds `builtin:pdf` to the catalog's rendering panels, so a `.pdf` opens in `PdfPreview` (react-pdf on web, react-native-pdf on phones) through `useFileUrl`. It is a `fallback` panel (`file-panels/resolve.ts`): it opens a PDF only when no plugin panel claims it, and Settings > Files never offers it, so upstream's plugin file panel specs hold unchanged. It sat ahead of plugin panels at first; that made every PDF plugin ask on open and replaced Source in Settings. Its title and icon live in `file-panels/choice/presentation.ts`. The loading spinner goes to the PDF libraries as a plain render function (`renderPdfLoadingIndicator`) on phones and as an element on web, never as a component: react-native-pdf calls `renderActivityIndicator` from a class render, and the React Compiler gives every component-named function a memo-cache hook, so v0.14.900 crashed the Android app on every PDF open. Vitest does not run the compiler, so the proof is a grep.

```bash
npm test --workspace=@getpaseo/app -- src/file-panels/fork-builtin-panels.test.ts --bail=1
grep -q '"builtin:pdf": PdfPanel' packages/app/src/file-panels/builtin.tsx
grep -q 'renderActivityIndicator={renderPdfLoadingIndicator}' packages/app/src/components/pdf-preview.native.tsx
```

## office-file-preview

**render Word, Excel, and PowerPoint in the file pane**

The daemon labels the Open XML extensions with their media types, and the `builtin:office` file panel renders those files on every platform, as a fallback a plugin panel overrides (see `pdf-file-preview`). Web paints into the page. Phone builds load the same renderers in a WebView, one document per format, from generated `office-preview-webview-*-html.ts` files. The build script resolves the Node polyfills `util` and `events` by path, so the app declares both as devDependencies: they used to arrive through other packages, and after the v0.14.0 sync `util` was gone and the script failed on a clean `npm ci`. A daemon that still sends application/octet-stream is recognized by extension. Legacy .doc and .ppt stay unavailable. The panel's extension list in `file-panels/catalog.ts` follows `OFFICE_PREVIEW_FORMATS` in `file-explorer/office.ts`. PowerPoint clears pptx-preview's black wrapper and fails a deck the library parses to no slides (`components/office-preview-pptx.web.ts`); the phone WebView inlines that renderer, so regenerate `office-preview-webview-*-html.ts` with `npm run build:office-preview-webview --workspace=@getpaseo/app` after changing it.

```bash
npm test --workspace=@getpaseo/app -- src/file-explorer/office.test.ts src/file-panels/fork-builtin-panels.test.ts src/components/office-preview-pptx.test.ts --bail=1
grep -q 'pptx-preview parsed no slides' packages/app/src/components/office-preview-webview-pptx-html.ts
node -e 'const d=require("./packages/app/package.json").devDependencies;process.exit(d.util&&d.events?0:1)'
npx vitest run --config packages/server/vitest.config.ts packages/server/src/server/file-explorer/service.test.ts --bail=1 -t "advertises Office document types"
```

## attention-window-focus

**heartbeat appVisible follows window focus, not document visibility**

client heartbeats report getIsAppActivelyVisible() so fullscreen Space swipes (document still visible, window unfocused) do not suppress attention

```bash
npx vitest run packages/app/src/utils/app-visibility.test.ts --bail=1 -t "fullscreen Space swipe"
```

## macos-focus-steal

**macOS attention focus steals from other Spaces**

focusing the desktop window on darwin calls app.focus({ steal: true }) before win.show/focus so three-finger Space swipe can bring Paseo forward

```bash
npx vitest run packages/desktop/src/features/window-focus.test.ts --bail=1
```

## mermaid-prose-tags

**neutralize mermaid placeholder tags instead of rejecting the diagram**

neutralizeDisallowedTags replaces disallowed tag opens with U+2039 before containsUnsafeMermaidSource so prose like <canonical URL> does not discard the whole diagram; real tags still fail closed; url() check requires word boundary and forbids whitespace before the opening parenthesis (CSS url() forbids whitespace; prose like 'URL (' does not); numeric HTML character entities (like &#35;) decode before tag checking so safe symbols are allowed while entity-smuggled tags fail closed; self-closing <i/> tags are not counted as unclosed. Do not rewrite a trailing `<i`/`<br` prefix — v0.7.2 streams those labels and a mid-tag ‹ swap clears the SVG. An unclosed `<i>` is still unsafe (mock streaming splits `Done["<i>Done</i>"]` into 4-char slices).

Fences tagged `mmd`, `mermaid-js` or `mermaidjs` render as diagrams too (`isMermaidFenceLanguage` in `fence/mermaid/segments.ts`, used by the native segment splitter and the web code-block renderer).

```bash
npx vitest run packages/app/src/components/markdown/fence/mermaid/source-policy.test.ts --bail=1
npm test --workspace=@getpaseo/app -- src/components/markdown/fence/mermaid/segments.test.ts --bail=1
```

## claude-native-fork

**Claude native fork from a chat message**

assistant stream/footer/menu can native-fork a Claude session at a boundary; wrapSessionProvider forwards resolveNativeForkUpToMessageId so the live session still resolves transcript UUIDs. AgentStreamView's memo must still compare turnPresentation and pendingMessageSubmissions — dropping those freezes the working footer after a disconnect.

```bash
npx vitest run packages/server/src/server/agent/provider-registry-wrap.test.ts packages/server/src/server/agent/providers/claude/native-fork.test.ts packages/app/src/agent-stream/fork-strategy.test.ts packages/protocol/src/messages.native-fork.test.ts --bail=1
grep -q "left.turnPresentation !== right.turnPresentation" packages/app/src/agent-stream/view.tsx
grep -q "left.pendingMessageSubmissions !== right.pendingMessageSubmissions" packages/app/src/agent-stream/view.tsx
```

## browser-localhost-tunnel

**workspace partitions with shared non-localhost cookies, tcpTunnel, and localhost links open in workspace Browser**

each Browser tab uses workspace-scoped persist:paseo-browser-workspace-${workspaceId} partitions with non-localhost cookies synced across workspaces and localhost cookies scoped to the workspace; daemon advertises tcpTunnel and mounts browser-preview before the service proxy; assistant localhost links open in that workspace Browser instead of the client machine; the real initial URL is assigned at webview creation so the guest reads it at birth, and post-registration forces one loadURL while still blank (covering the tunnel path needing the ready proxy and aborted first commits); blank taken residents reload the same way, because remounts and guest-replacing reparents otherwise strand the webview on about:blank; direct re-registration skips setProxy when already direct, because re-applying it after the guest attached kills the first navigation exactly like the tunnel path already guarded; tcp-tunnel frames carry the opening source so delivery proofs authorize OpenResult/Data replies, without which every tunnel open connects but its reply never reaches the client

```bash
npx vitest run packages/desktop/src/features/browser-cookies.test.ts packages/desktop/src/features/browser-profile.test.ts packages/desktop/src/features/browser-webviews/index.test.ts packages/app/src/utils/localhost-url.test.ts --bail=1
npx vitest run packages/server/src/server/tcp-tunnel-forwarder.test.ts --bail=1
grep -q "isBlankWebview" packages/app/src/desktop/browser/pane/index.electron.tsx
npx vitest run packages/desktop/src/features/browser-loopback-direct.test.ts --bail=1
```

## code-server-tab

**register Code Server as a workspace tab kind**

panel-manifest and register-panels keep the codeServer tab so a workspace can open host-advertised VS Code in-pane

The tab, and the web Browser tab, read `urlOpeners` and `browserPreview` from the session's server info, so `toDaemonServerInfo` in `stores/session-store.ts` must copy both from the handshake. The fork once kept them in a separate `utils/server-info.ts` that no caller imported, so the launcher never offered either tab on web; v0.14.900 release QA found it. That file is gone and its test moved to `stores/server-info.test.ts`.

```bash
npx vitest run packages/app/src/panels/panel-manifest.test.ts packages/app/src/workspace-tabs/launcher/internal/catalog.test.ts --bail=1
npm test --workspace=@getpaseo/app -- src/stores/server-info.test.ts --bail=1
```

## guest-webview-focus

**guest webview and Electron OS focus count as in-app**

getIsAppActivelyVisible treats focused WEBVIEW/IFRAME and BrowserWindow.isFocused as looking at Paseo so Code Server does not yank chat

```bash
npx vitest run packages/app/src/utils/app-visibility.test.ts --bail=1 -t guest
```

## codex-quota-reset

**Settings can reset Codex credits**

The Codex usage card resets credits through `provider.usage.reset_quota` (daemon.manage), served by UsageSession from the Codex OAuth reset-credits endpoint with one token refresh; the card force-refreshes afterwards so a pre-reset in-flight list is not shown as current usage

```bash
npx vitest run packages/server/src/server/session/usage/codex-quota-reset.test.ts packages/server/src/server/session/usage/usage-session.test.ts --bail=1
```

## metadata-endpoint-persist

**persist metadata custom endpoint without writing empty default**

persisted-config keeps metadataGeneration.customEndpoint; daemon-config-store must not persist the default-empty object or a sync/restart wipes a configured URL

```bash
npx vitest run packages/server/src/server/persisted-config.test.ts packages/server/src/server/daemon-config-store.test.ts --bail=1
```

## history-search

**History list is searchable**

sessions-screen keeps a free-text filter so a long-lived host remains scannable

```bash
npx vitest run packages/app/src/utils/session-list-search.test.ts --bail=1
```

## history-hosts-reactive

**History notices a host that connects after the screen opened**

`useAgentHistory` reads host connection statuses as values (`useHostRuntimeConnectionStatuses`) instead of upstream's `void runtimeVersion` inside a `useMemo`. The React Compiler drops a read kept only for reactivity, so a host that came online after the first render stayed "unreachable": History showed "Could not load history" for every host, sent no request, and hid the search field until the host list itself changed. `sessions-search-hosts.spec.ts` hung its full 7-minute budget on attempt 1 in each of the fork's last CI runs and hangs every time locally; with this change it passes 6 of 6. Upstream has the same code and passes on timing. `schedules-screen.tsx` and `use-aggregated-agents.ts` still use the pattern.

```bash
! grep -q "void runtimeVersion" packages/app/src/hooks/use-agent-history.ts
grep -q "useHostRuntimeConnectionStatuses(requestedServerIds)" packages/app/src/hooks/use-agent-history.ts
```

## schedules-search

**Schedules list is searchable**

schedules-screen keeps a free-text filter so a long-lived host remains scannable

```bash
npx vitest run packages/app/src/utils/schedule-list-search.test.ts --bail=1
```

## sidebar-backlog

**global Backlog row in the left sidebar**

a fork-owned Backlog row with add-task sits alongside the preference-driven nav rows in left-sidebar; buildBacklogRoute stays the /backlog deep link. It lives outside the sidebar-nav model on purpose: the model's exact-list tests and the nav-settings e2e pin the four upstream builtins

```bash
npx vitest run packages/app/src/utils/host-routes.test.ts --bail=1 -t buildBacklogRoute
```

## host-badge-glyph

**host badges can omit the server glyph**

selectHostBadges copies showIcon onto each badge so hiding identity icons is label-only, not a missing badge

```bash
npx vitest run packages/app/src/hosts/appearance.show-icon.test.ts --bail=1
```

## workspaces-group-mode

**Workspaces header keeps inline Project|Status grouping**

left-sidebar Workspaces header mounts SidebarGroupModeControl and hides it below 300px; Group by stays in the gear menu

```bash
npx vitest run packages/app/src/components/sidebar/sidebar-group-mode-policy.test.ts --bail=1
```

## pinned-workspace-tabs

**workspace tab strip can pin Browser and Code Server**

new-tab menu and desktop tabs row import workspace-pins so pinned targets stay one tap on the strip

```bash
npx vitest run packages/app/src/workspace-pins/target.test.ts --bail=1
```

## claude-200k-1m-rows

**Opus 5, Fable 5.1, and Fable 5 expose both 200K and 1M picker rows**

claude model-manifest keeps dual context-window rows so a 200K pick is explicit and does not silently become 1M. v0.7.2 added Fable 5.1 as a silent 1M row; the CLI catalog fixture must list the dual rows, not upstream's alias-hidden shape.

```bash
npx vitest run packages/server/src/server/agent/providers/claude/models.test.ts --bail=1 -t "defines context window sizes"
rg -q 'claude-fable-5-1\[1m\]' packages/cli/tests/15-provider.test.ts
```

## interaction-lock

**sidebar and agent list honor interaction lock**

workspace menu and agent-list refuse send/archive while locked so monitor mode cannot fat-finger a prompt

```bash
npx vitest run packages/app/src/interaction-lock/policy.test.ts --bail=1
```

## custom-model-picker

**provider diagnostic sheet can add and edit custom models**

model-browser and provider-diagnostic-sheet keep add/edit custom model plus models.dev lookup; overwrite env patch does not protect this UI

```bash
npx vitest run packages/protocol/src/messages.metadata-custom-endpoint.test.ts packages/server/src/server/models-dev/catalog.test.ts --bail=1
```

## mermaid-error-caption

**failed mermaid renders an error caption instead of a blank fence**

host.web/native and render-model keep errorMessage so a rejected diagram explains why; neutralize patch does not cover host UI

```bash
npx vitest run packages/app/src/components/markdown/fence/mermaid/render-model.test.ts --bail=1
```

## composer-draft-sync

**composer draft hydrates from host ui_state**

input-draft keeps host ui_state sync so composer text survives switching devices. Every user edit writes the host copy: `editText` and `replaceText` as well as `saveDraft`. Official #4902 moved typing off `saveDraft` onto `editDraftText`, which left the host write on the attachments path only, so v0.14.900 shipped with typed drafts never reaching the host. Remote records land through the store and are published into the input with `publishTextReplacement`, never through those two callbacks, so a synced edit does not echo back.

Live updates need two things official's owned-subscription model does not give a fork push for free. The daemon delivers an unsolicited message to a modern client only as a subscribed session event, so the fork's pushes (`ui_state.updated`, workspace todos, background tasks and their output, provider heartbeats) are listed once in `FORK_SESSION_EVENTS` in protocol `messages.ts`. The event subscription schema, `sessionEventCategory` in `server/session.ts` and the app's subscription in `runtime/fork-session-events.ts` all read that list; add a new fork push there or no current client receives it. The app subscribes when `server_info.features.forkSessionEvents` is set: a daemon without the flag would reject the whole subscription over an unknown event name. Without this, every fork push was dropped at the socket since the v0.8 sync. And since official isolated typing, the input owns its text, so the `ui_state.updated` handler in `input-draft.ts` publishes accepted remote text with `publishTextReplacement`; a store write alone never reaches the screen.

Review drafts sync the same way (`ui-state/review-host-sync.ts`). Every path that removes comments locally must also write the host copy: the review surface hydrates from the host when it mounts, so a comment removed only locally comes back. v0.14.0's Send feedback clears sent comments through `clearSentReviewDraftComments`, so `review/feedback/use-feedback.ts` calls `syncReviewDraftToHost` after it; without that, official's `composer-diff-stat` spec sees the review pill return after a layout switch.

```bash
npx vitest run packages/app/src/composer/draft/input-draft.test.ts packages/app/src/ui-state/composer-host-sync.test.ts packages/protocol/src/ui-state/schemas.test.ts --bail=1
grep -q 'syncReviewDraftToHost(reviewDraftKey)' packages/app/src/review/feedback/use-feedback.ts
npm test --workspace=@getpaseo/app -- src/composer/draft/input-draft.live.test.tsx --bail=1 -t "mirrors typed and replaced text to the host"
npx vitest run --config packages/server/vitest.config.ts packages/server/src/server/ui-state/fork-session-events.e2e.test.ts --bail=1
grep -q "publishTextReplacement(\"replace\", after)" packages/app/src/composer/draft/input-draft.ts
```

## mobile-push-diagnostics

**settings expose mobile push diagnostics**

settings-screen keeps MobileNotificationsSection so fork APKs can see why Expo push is silent

```bash
npx vitest run packages/app/src/data/push-router.test.ts --bail=1
```

## cliproxy-model-windows

**CLIProxy discovered models persist additionalModels limits**

provider-snapshot-manager persistClaudeAdditionalModelLimits keeps CPA-discovered windows across daemon restarts

```bash
npx vitest run packages/server/src/server/agent/provider-snapshot-manager.test.ts packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1
```

## steer-official-only

**Drop fork steer dual-path**

dispatch uses official steerActiveTurn only; fork session.steer / steerAgent / composer steer flag / unmounted Queue-steer copy are gone; COMPAT wire steer boolean and supportsSteer stay

```bash
npx vitest run packages/server/src/server/agent/provider-registry-wrap.test.ts packages/protocol/src/messages.steer.test.ts packages/protocol/src/messages.active-turn-behavior.test.ts packages/app/src/composer/actions.test.ts --bail=1
npm run test:unit --workspace=@getpaseo/server -- src/server/agent/providers/omp/agent.test.ts --bail=1
```

The omp suite runs through the server workspace on purpose: root `npx vitest` applies the 5s default timeout, and the prompt-rejection tests wait out the 5s no-turn settle window. The server config gives them 30s.

## workspace-mark-unread

**Workspaces can be marked as unread**

workspace menu exposes Mark as unread when a workspace is done; daemon marks the newest finished root agent with attention to surface in attention group (one per workspace; opening the workspace reveals that agent, which clears it). Batch requests fan out per workspace with per-workspace results; the response keeps markedAgentId for pre-batch clients

```bash
npx vitest run packages/protocol/src/messages.workspaces.test.ts packages/server/src/server/session.workspaces.test.ts packages/client/src/daemon-client.test.ts --bail=1
```

## fork-rpc-permissions

**fork RPCs are in the v0.7.0 semantic permission map**

owner authority covers workspace.mark_unread, workspace.todos, native_fork, background_tasks, heartbeats, ui_state, tasks, and the other fork session operations; a missing map entry is a silent deny

```bash
npx vitest run packages/server/src/server/authorization/index.test.ts --bail=1 -t "owner authority"
```

## workspace-todo-sidebar

**per-workspace todo list in explorer sidebar, left sidebar, and composer**

workspace-scoped todo checklist with Apple Notes style UI, Explorer sidebar tab, left sidebar progress indicator, and composer pill. Default Explorer focus stays Changes so Cmd+E matches official; the extra Todo tab would otherwise become the last-tab default. The Todo tab is persistent utility chrome: bulk close-others spares it (`handleCloseOtherTabsInPane` filters `target.kind !== "todo"`, `packages/app/src/screens/workspace/workspace-screen.tsx`), so the Explorer bulk-close count matches official's two-tab default; its own Close entry still dismisses it.

v0.7.0 plugin navigation imports expo-router from the registry. Root `npx vitest` does not apply the app vitest config (JSX transform, `__DEV__`, expo-router mock), so run these through the app workspace.

```bash
npm test --workspace=@getpaseo/app -- src/todos/workspace-todo-store.test.ts src/todos/workspace-todo-pane.test.tsx src/composer/todo-pill.test.tsx src/panels/agent-tracks.test.ts src/components/sidebar/workspace-meta-row/meta-items.test.ts src/components/sidebar/display-preferences/row-items.test.ts src/workspace-tabs/explorer-sidebar.test.ts src/stores/panel-store/state.test.ts src/stores/workspace-layout-store.test.ts src/i18n/resources.test.ts --bail=1
```

## explorer-ports-tab

**the workspace's script ports open as a Ports tab**

The Ports list (`components/explorer-ports-pane.tsx`) was a fixed tab of the fork's compact Explorer. v0.14.0 deleted that Explorer (`compact-explorer-sidebar.tsx`) and runs every layout on ordinary workspace tabs, which dropped Ports. It is now a `ports` tab kind like Todo: a panel (`panels/ports-panel.tsx`), a launcher entry after Todo, and a singleton only the Explorer hosts, like Changes and Files. It is not a default Explorer tab, so the Explorer's tab count matches official. It could open in a main pane at first; that added a tile to the main pane's New-tab launcher and broke official's `explorer-pane-placement` spec, which clicks above the centred launcher.

```bash
npm test --workspace=@getpaseo/app -- src/workspace-tabs/launcher/internal/catalog.test.ts --bail=1
grep -A2 'kind: "ports"' packages/app/src/panels/panel-manifest.ts | grep -q 'supportedHosts: \["explorer"\]'
grep -q 'portsPanelRegistration' packages/app/src/panels/register-panels.ts
```

## replica-repaint-keeps-reply-in-tail

**a second cache prepare leaves the rows it already painted alone**

`prepareCachedTimeline` (`packages/app/src/timeline/viewed-timeline-sync.ts`) runs again whenever a chat is prepared after an earlier preparation settled. When the timeline is still `painted` from that same cached replica, upstream hands the painted rows back in as the live head, and `preserveReplacementHead` keeps the finished last reply there because its text starts with the canonical copy. A head row makes the latest turn read as open, so Collapse turns never folds it after a reload. Official's suite does not reach it: against an official daemon the reloaded app sends no directory cursor and gets a full agent snapshot, while against the fork daemon it resumes with a delta that changes nothing and the chat stays painted (observed in `turn-collapse.spec.ts`, the cause of the cursor difference not traced). The fork returns early when the painted rows are exactly the stored rows and there is no live head.

```bash
npm test --workspace=@getpaseo/app -- src/timeline/replica.test.ts -t "prepared again" --bail=1
```

## pending-open-before-agent-tabs

**a deep-linked tab is revealed before the workspace auto-opens its other agent tabs**

`workspace-screen.tsx` reconciles agent tabs as soon as the agents are known, but a pending open (`?open=agent:…`, a notification or a deep link) waits until the workspace list hydrates (`usePendingWorkspaceOpen`). In the gap the first auto-opened agent tab becomes active, and the pane's mounted-tab LRU keeps it mounted after the requested tab takes over, so its hidden composer duplicates every composer test id. Against the fork daemon workspaces hydrate about 1.4s after agents, and official's `composer-diff-stat` "only open tabs in this workspace" spec failed 4 of 5 runs (official daemon: 4 of 4 green). The fork skips tab reconciliation while a pending open target exists.

```bash
grep -A2 "Fork: a pending open" packages/app/src/screens/workspace/workspace-screen.tsx | grep -q "if (pendingOpenTarget)"
```

## live-user-message-flush

**commit provider user_message acks before the stream coalescer frame**

flush live user_message through the stream coalescer in the same turn as onmessage; disconnect flushes pending acks so submissions settle instead of hanging. (v0.8.0 upstream removed the session-store liveness map, so there is no store clearing to do; turns live on the Agent record and reconcile on catch-up. The offline chrome gating went with it: the drop-socket spec pins the working indicator visible after a drop, so hiding it while reconnecting contradicts the contract.)

```bash
npm test --workspace=@getpaseo/app -- src/timeline/ingest-agent-stream-event.test.ts src/timeline/turn-liveness.test.ts --bail=1
```

## assistant-delta-append

**live assistant chunks append; only canonical snapshots replace by prefix**

projected history snapshots replace a stored prefix by overlap, but live provider deltas always append: a delta that repeats the opening text (the closing `**` of a bold span is a prefix of the row) is new content, and prefix-matching it away drops characters from every streamed reply. snapshot overlap still replaces so a replica-painted prefix plus the full fence does not fuse into `Anno```mermaidflowchart`.

```bash
npm test --workspace=@getpaseo/app -- src/types/stream.test.ts --bail=1
```

## plugin-head-turn-phase

**live-head plugin cards use the turn phase, not hardcoded streaming**

the stream head holds completed-but-not-yet-reconciled rows after a turn closes; rendering those plugin cards as `streaming` unconditionally strands them on the streaming template (a post-reload fetch that reconciles into head never flips them). pass `isTurnActive` so a closed turn completes head cards exactly like the chat message path does.

```bash
npm test --workspace=@getpaseo/app -- src/agent-stream/presentation.test.ts --bail=1
```

## paseo-backed-claude-subagent-prompt-cache-ttl

**5m prompt cache TTL for orchestrator-spawned Claude agents**

parented Claude agents created via create_agent default featureValues.prompt_cache_ttl=5m; explicit caller value wins verbatim; a non-parented Claude agent starts at 1h like any new agent ([claude-prompt-cache-warming](#claude-prompt-cache-warming), Defaults), and non-Claude agents are untouched; buildOptions maps the value onto the SDK env via CLAUDE_CODE_PROMPT_CACHE_TTL (5m/1h set it, default/missing/invalid unset, user env wins); prompt_cache_ttl (Cache window) select feature always visible for Claude Code agents (an existing agent with no stamped value shows 'default'; a draft shows the new-agent 1h); setFeature validates against default/5m/1h and marks the query for relaunch, because Claude Code reads CLAUDE_CODE_PROMPT_CACHE_TTL only when its process starts; cache warm-up defaults for these children follow [claude-prompt-cache-warming](#claude-prompt-cache-warming)

```bash
npx vitest run packages/server/src/server/agent/create-agent/create.test.ts packages/server/src/server/agent/providers/claude/agent.test.ts packages/server/src/server/agent/providers/claude/agent.env.test.ts packages/server/src/server/agent/mcp-server.test.ts --bail=1
```

## sidebar-background-heartbeat-indicators

**sidebar background heartbeat indicators**

Show running indicator for background tasks/shells with bash icon and heartbeat next-run pill in workspace sidebar meta row

```bash
npx vitest run packages/app/src/components/sidebar/workspace-meta-row/meta-items.test.ts packages/app/src/heartbeats/track-presentation.test.ts packages/app/src/background-tasks/track-presentation.test.ts --bail=1
```

## agent-auto-resume

**auto-resume running agents after power cut**

resume agents that were running when daemon shut down unexpectedly (SIGTERM/powercut/UPS) by sending 'Resume - there was a power cut' on next boot; intentional daemon stop via client_shutdown_rpc skips; Hub-owned executions (owner kind daemon) never resume at daemon level — the Hub protocol replays or closes them itself, and resuming resurrects agents Hub already closed. The candidates are the stored records read when the registry loads, because the resume itself waits for the boot catalog warm-up; by then an agent created or prompted since boot also reads as running, and resuming it would interrupt live work. The resume prompt also refuses to replace a run (`replaceRunning: false`).

```bash
npx vitest run packages/server/src/server/agent/agent-auto-resume.test.ts --bail=1
grep -q 'bootRecords: autoResumeBootRecords' packages/server/src/server/bootstrap.ts
```

## agent-auto-resume-system-envelope

**the resume prompt is a system injection, not a user turn**

The auto-resume prompt used to dispatch as an ordinary `user_message`, so the app drew it as a bubble that looked like the user had typed it, and the agent treated it as a request. It now goes through `formatSystemNotificationPrompt`, the same `<paseo-system>` envelope chat mentions and finish notifications already use. Since v0.14.0 the timeline projects every such envelope as a compact system card (`projectAgentMessage` in `agent-messages/envelope.ts`) instead of dropping it, so the prompt shows as that card, never as a user bubble. The human-facing record of the restart is the resume marker above, which is what carries `interruptedAt`. `DEFAULT_AUTO_RESUME_PROMPT` stays the public, configurable string, so `daemon.autoResumeRunningAgents.prompt` and `PASEO_AUTO_RESUME_PROMPT` keep working unchanged.

The marker is appended before the send, not after: `sendPromptToAgent` returns once the provider run is in flight, so emitting afterwards raced the agent's first response and stranded the marker mid-message.

```bash
npx vitest run packages/server/src/server/agent/agent-auto-resume.test.ts --bail=1
grep -q 'formatSystemNotificationPrompt(prompt)' packages/server/src/server/agent/agent-auto-resume.ts
! grep -q 'prompt,$' packages/server/src/server/agent/agent-auto-resume.ts
```

## agent-auto-resume-timeline-marker

**the daemon marks a resumed agent in the timeline, and only capable clients receive the marker**

The auto-resume sweep already replays a prompt; this adds a visible record of it. Before dispatching, the sweep appends a `{type:"resume", reason:"power_cut", interruptedAt}` timeline item, rendered app-side as a bordered marker beside the existing compaction one. `interruptedAt` carries the pending file's `capturedAt`; a `reason` of `manual` carries no `interruptedAt`. The item goes through `appendTimelineItem`, which needs a live snapshot — hence the `ensureAgentLoaded` that precedes it, and the load doubles as the resume path the sweep was already about to take.

`ResumeTimelineItem` joins `AgentTimelineItem` in both the protocol and the server's own copy of that union, and the `resume` branch joins the pure `AgentTimelineItemPayloadSchema` union — optional fields only, so a six-month-old app still parses the message and an old daemon never sends one. Delivery is gated once on `CLIENT_CAPS.resumeTimelineItems` in `supportsTimelineItem`, the same one-place detection the notification and plugin item gates use; no fallback path renders a degraded variant.

```bash
npx vitest run packages/server/src/server/agent/agent-auto-resume.test.ts packages/protocol/src/messages.wire-compat.test.ts --bail=1
grep -q 'z.literal("resume")' packages/protocol/src/messages.ts
grep -q 'CLIENT_CAPS.resumeTimelineItems' packages/server/src/server/session.ts packages/client/src/connection/index.ts
grep -q 'resumeTimelineItems: "resume_timeline_items"' packages/protocol/src/client-capabilities.ts
```

## agent-auto-resume-app-marker

**the app renders the resume timeline item as a marker beside the compaction one**

`ResumeItem` joins `StreamItem`, so the reducer appends one marker per resume event — same `createUniqueTimelineId` + `finalizeActiveThoughts` shape as the compaction case — and the replica cache stores it under a `z.strictObject` union member so a cached timeline round-trips instead of being dropped. `ResumeMarker` reuses the compaction marker's visual language verbatim (two `flex: 1` 1px rules in `theme.colors.border` around a centred muted label), differing only in the `Power` glyph; the label comes from `message.resume.*` via a sibling `message-resume-label.ts` helper, matching the compaction helper, so no English literal reaches the component. Both plugin projection and web height estimation treat `resume` like `compaction` so a marker is neither invisible to a plugin transform nor mis-measured by the virtualizer.

```bash
npm test --workspace=@getpaseo/app -- src/components/message-resume-label.test.ts src/types/stream.test.ts src/i18n/resources.test.ts --bail=1
grep -q 'kind: z.literal("resume")' packages/app/src/runtime/replica-cache/index.ts
grep -q 'case "resume":' packages/app/src/agent-stream/view.tsx packages/app/src/plugins/timeline/projection.ts packages/app/src/agent-stream/web-virtualization.ts
grep -q 'i18n.t("message.resume' packages/app/src/components/message-resume-label.ts
! grep -q 'Resumed after an unexpected shutdown' packages/app/src/components/message.tsx
```

## schedule-run-live-work

**a scheduled run keeps its workspace while the work it started is still running**

archiveOnFinish waits on live work instead of killing it: non-terminal background tasks (shells, monitors), provider heartbeats, active or paused Paseo heartbeats targeting the run agent, busy terminals in the workspace, running child agents, and — for a worktree run only — a schedule pointed inside the directory the archive would delete. Idle terminals and finished tasks do not pin the workspace. The deferred archive is retried until the work ends.

```bash
npx vitest run packages/server/src/server/schedule/live-work.test.ts packages/server/src/server/schedule/service.test.ts --bail=1
```

## browser-web-devtools-bridge

**daemon injects a devtools bridge into proxied preview HTML, and the Browser tab is reachable off Electron**

browser-preview rewrites text/html responses to splice a navigation, eruda and element-selector bridge into `<head>`; the web Browser pane drives it over postMessage for history, URL sync, devtools and element attachments. The pane itself lives in fork-owned `web-pane.tsx`, with upstream's `index.web.tsx` reduced to a shim that renders it. Every surface that opens a Browser tab is gated on `useWorkspaceBrowserAvailability`, not `getIsElectron()` — the resolver already answered true for web with a preview template and for Android with a tunnel, while the call sites hard-coded Electron and made the feature unreachable. Nothing is added to `server_info`; the injected script announces itself with a `ready` message, so `packages/protocol` is untouched. `PASEO_BROWSER_PREVIEW_URL_TEMPLATE` is in official's `DAEMON_SETTING_ENV_KEYS` (`packages/server/src/server/config-environment.ts`): config resolution only sees allowlisted variables, so v0.14.900 silently ignored the env var and only `daemon.browserPreview.urlTemplate` in config.json worked.

```bash
npx vitest run packages/server/src/server/browser-preview/html-injection.test.ts packages/server/src/server/browser-preview/inject packages/app/src/desktop/browser/pane/web-bridge.test.ts packages/app/src/desktop/browser/pane/web-navigation.test.ts packages/app/src/desktop/browser/pane/web-submit.test.ts packages/app/src/desktop/browser/pane/web-pane.test.tsx --bail=1
grep -q "createHtmlInjectionStream" packages/server/src/server/browser-preview/index.ts
grep -qF 'from "./web-pane"' packages/app/src/desktop/browser/pane/index.web.tsx
grep -q "showCreateBrowserTab = useWorkspaceBrowserAvailability" packages/app/src/screens/workspace/workspace-screen.tsx
grep -q "hasWorkspaceBrowser = useWorkspaceBrowserAvailability" packages/app/src/command-center/workspace-registration.tsx
! grep -q "showCreateBrowserTab = getIsElectron()" packages/app/src/screens/workspace/workspace-screen.tsx
! grep -q "persistenceKey || !getIsElectron()" packages/app/src/screens/workspace/workspace-screen.tsx
npx vitest run --config packages/server/vitest.config.ts packages/server/src/server/config-browser-preview.test.ts --bail=1
```

## nix-desktop-build-heap

**the Nix desktop build raises the Node heap for the Expo web export**

The fork bundle carries more modules than upstream's, so `expo export` exceeds the default ~2G heap and the macOS build dies with a jest worker SIGTERM. Release builds already size the heap per arch; the Nix derivation gets the same 4096 arm64 floor.

```bash
grep -q "max-old-space-size=4096" nix/desktop-package.nix
```

## nix-update-hash-github-token

**the Nix hash auto-updater authenticates with `GITHUB_TOKEN` instead of the upstream GitHub App**

`nix/npm-deps.hash` pins the fixed-output derivation of the npm dependency tree, so any lockfile change makes `nix build` fail until the hash is refreshed. Upstream's updater opens with `actions/create-github-app-token@v1` reading `PASEO_BOT_APP_ID` / `PASEO_BOT_APP_PRIVATE_KEY`. A fork cannot inherit organization secrets, so that step failed before checkout on every push — 30 runs, 30 failures, never once green, and the stale hash then surfaced as a red `Nix` check on the next PR instead. The job now checks out with the default `GITHUB_TOKEN` and `contents: write`, which can push to this fork's unprotected `main`; the existing `[skip ci]` commit message stops it re-triggering CI, and the bot identity matches the token actually doing the push.

```bash
! grep -q "create-github-app-token" .github/workflows/nix-update-hash.yml
! grep -q "PASEO_BOT_APP_ID" .github/workflows/nix-update-hash.yml
grep -q "contents: write" .github/workflows/nix-update-hash.yml
```

## archive-responds-before-cleanup

**workspace archive answers on the record, not on disk cleanup**

archive_workspace_request resolves once archivedAt is durable and runs paseo.json worktree.teardown plus the directory removal in the background, after giving that cleanup a 15s grace (`ARCHIVE_DIRECTORY_CLEANUP_GRACE_MS` in session.ts) so an ordinary archive still answers with its directory gone, which v0.14.0's worktree e2e asserts. A slow teardown no longer pushes the reply past the client's 60s RPC timeout and the client no longer restores a workspace the daemon archived; the archived state is published before the slow phase so other clients converge, the settling emit still runs after it, and teardown commands are bounded by PASEO_WORKTREE_TEARDOWN_TIMEOUT_MS (default 10 minutes) with the timeout named in the failure

```bash
npx vitest run --config packages/server/vitest.config.ts packages/server/src/server/workspace-archive-service.test.ts packages/server/src/server/session.workspaces.test.ts packages/server/src/utils/worktree.posix.test.ts --bail=1
```

## fork-apk-setup-android-packages

**the fork APK release installs only `platform-tools`, not the removed `tools` package**

`android-actions/setup-android@v3` defaults to `packages: 'tools platform-tools'`, but Google removed the obsolete `tools` package from the SDK repository, so the default invocation dies with "Failed to find package 'tools'" (red since mid-September, including pre-sync main). The Gradle/Expo APK build only needs what the runner image already preinstalls plus `platform-tools`.

```bash
grep -q "packages: platform-tools" .github/workflows/android-apk-release.yml
```

## fork-apk-scripts-exist

**every npm script the fork APK job runs still exists**

The fork's `publish-fork-android-apk` job lives in official `android-apk-release.yml` and calls workspace scripts directly. Official v0.13 deleted `build:terminal-webview` with the WebView terminal renderer (#7639 upstream), the sync kept the step, and the `v0.14.900` tag's APK run died on "Missing script". The step is gone; native builds draw the terminal natively, and the Office preview webviews are committed generated files. The proof resolves each `npm run` in the workflow against the root or named workspace `package.json`, so the next script official removes fails here instead of on a release tag.

```bash
node -e 'const fs=require("fs");const g=require("path");const ws={};for(const r of ["packages","plugins"])for(const d of fs.existsSync(r)?fs.readdirSync(r):[]){const f=g.join(r,d,"package.json");if(fs.existsSync(f)){const j=JSON.parse(fs.readFileSync(f));ws[j.name]=j.scripts||{}}}const root=JSON.parse(fs.readFileSync("package.json")).scripts;const t=fs.readFileSync(".github/workflows/android-apk-release.yml","utf8");let bad=0;for(const [,s,w] of t.matchAll(/npm run ([\w:.-]+)(?:\s+--workspace[= ](@?[\w/.-]+))?/g)){if(!(w?ws[w]:root)?.[s]){console.error("missing script",s,w||"(root)");bad=1}}process.exit(bad)'
```

## claude-gateway-model-switch

**switch to and display CLIProxyAPI gateway models**

Mid-session `setModel` to a gateway model (muse-spark-_) failed with "Couldn't confirm model with the API" while the TUI accepted the same ID, and TUI-side switches displayed as first-party `claude-fable-5` after reload. On control-plane confirmation failure Paseo relaunches the query on the resumed session with the new model; `claude-fable-5-dd-_` wire IDs no longer normalize to the manifest and observed wire IDs decode back to raw catalog IDs for display.

```bash
npx vitest run packages/server/src/server/agent/providers/claude/models.test.ts packages/server/src/server/agent/providers/claude/agent.test.ts --bail=1
```

## gateway-first-party-routing

**one `agents.gateway` routing shared by base claude/codex/opencode**

`agents.gateway` (or `PASEO_GATEWAY_*` env) routes the base providers through CLIProxyAPI without per-provider entries: the registry merges the Gateway env layer under explicit override env for claude/codex and passes the resolved routing to all three clients. Providers with their own routing (Anthropic keys, Z.AI, custom Codex endpoints) and every derived provider are exempt.

```bash
npx vitest run packages/server/src/server/agent/gateway/config.test.ts packages/server/src/server/agent/provider-registry.test.ts packages/server/src/server/persisted-config.test.ts --bail=1
```

## gateway-detection

**Gateway detection without `X-CPA-*` headers plus explicit-routing skip**

Live Gateways omit `X-CPA-*` response headers on `/v1/models`, which silently disabled all discovery. Auto-detect paths now also accept behavioral proof — `claude-fable-5-dd-` listing ids on the Anthropic shape, a `models` envelope on the Codex shape — and first-party routing skips detection outright via `expectGateway`.

```bash
npx vitest run packages/server/src/server/agent/gateway/models.test.ts packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1
```

## gateway-claude-launch

**Claude Gateway launch: WebSearch rule, image gating, immediate capacity**

Gateway-routed custom models disallow `WebSearch` unless the gateway advertises `cpa_capabilities.claude_web_search: true` (a proxy without the bit or with `false` still disallows it to prevent ungrounded or failing searches), gate image blocks on known `inputModalities` with a file-hint fallback, merge auto-persisted limits (now including modalities) into the running client's in-memory models so the first post-discovery session launches with resolved capacity.

```bash
npx vitest run packages/server/src/server/agent/providers/claude/agent.env.test.ts packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1
```

## gateway-codex-discovery

**Codex Gateway discovery with bare-slug ids, context windows, and thread provider routing**

Gateway-routed Codex (first-party or a derived provider pointing at a Gateway) appends Codex-shape catalog rows — hidden skipped, reasoning levels mapped to thinking options, advertised context windows overlaid on base models, bare-slug ids routed by the synthetic `cliproxyapi` thread `model_provider` — to `model/list` results.

```bash
npx vitest run packages/server/src/server/agent/providers/codex-app-server-agent.test.ts --bail=1
```

## gateway-claude-effort-identity

**Gateway Claude models get their advertised effort levels and their real name**

Gateway-routed Claude models take their effort levels from the Codex-shape catalog instead of one hardcoded set, and Claude Code is told the model's real name and capabilities through `ANTHROPIC_CUSTOM_MODEL_OPTION_*` / `ANTHROPIC_DEFAULT_FABLE_MODEL_*`. A model the catalog does not describe keeps the full set. The capability list uses the same `max_effort` / `xhigh_effort` tokens Claude Code's own model catalog carries.

```bash
npx vitest run packages/server/src/server/agent/providers/claude/cliproxy-effort.test.ts packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1
```

## gateway-codex-cpa-window

**Codex launch and catalog use the CPA window and model catalog**

Gateway-discovered models and base models routed through CLIProxyAPI use their advertised context window instead of being capped to Codex's 272k fallback window (258k usable). The catalog overlays advertised context windows onto existing models, writes a merged `codex-model-catalog.json` for `codex app-server`, passes `model_context_window` in thread configuration, and preserves the full context window in usage tracking.

The catalog lives in the daemon's `$PASEO_HOME`. A provider `env` that sets `PASEO_HOME` overrides it; any other provider `env` (a derived provider's `OPENAI_*`) does not, so it cannot redirect the catalog to `~/.paseo`. Before this, a test run overwrote the real catalog with fixture rows, and gateway models absent from that file compacted at Codex's own default window. The repo-root vitest config sets a temp `PASEO_HOME` for the same reason.

```bash
npx vitest run packages/server/src/server/agent/providers/codex-catalog.test.ts packages/server/src/server/agent/gateway/models.test.ts --bail=1
npx vitest run packages/server/src/server/agent/providers/codex-app-server-agent.test.ts --bail=1 -t "daemon PASEO_HOME"
```

## gateway-opencode-provider

**OpenCode Gateway provider injection with a live models map**

Every spawned OpenCode server gets an additive `cliproxyapi` provider record (openai-compatible adapter, options, models map built from live Gateway rows with trusted limits) so Gateway slugs register, list, and run sessions; user-defined `provider.cliproxyapi` wins entirely, and the Paseo catalog appends `cliproxyapi/<slug>` rows with the same trust rules.

```bash
npx vitest run packages/server/src/server/agent/providers/opencode-agent.test.ts packages/server/src/server/agent/providers/opencode/bridge.test.ts packages/server/src/server/agent/providers/opencode-server-manager.test.ts --bail=1
```

## gateway-omp-litellm

**first-party Gateway routes base OMP through `LITELLM_*` env**

When `agents.gateway` is set and the base omp provider has no `LITELLM_BASE_URL`/`LITELLM_API_KEY` of its own, the registry injects the Gateway endpoint under explicit provider env. The binary exposes it as its `litellm` provider, so Gateway slugs, limits, and thinking levels appear in the OMP catalog as `litellm/<slug>` with no client changes; derived OMP profiles never inherit the routing.

```bash
npx vitest run packages/server/src/server/agent/gateway/config.test.ts packages/server/src/server/agent/provider-registry.test.ts --bail=1
```

## gateway-quota

**per-model Gateway quota in the context-meter popover, hidden when unsupported**

The `gateway.quota.get` RPC (gated on `server_info.features.gatewayQuota`) maps the agent's Paseo model id to a Gateway slug and fetches `/v1/quota`, cached 60 seconds, only for Gateway-routed providers. Old Gateways without the route answer empty-body 404s; those and every other failure return `supported: false` and the popover renders nothing instead of an error. The sections mount inside each meter surface (sheet, tooltip, hover card), which unmount while closed, so reads and the stats poll only run while open.

```bash
npx vitest run packages/server/src/server/agent/gateway/quota.test.ts packages/server/src/server/session/provider/provider-catalog-session.test.ts packages/protocol/src/messages.test.ts --bail=1
```

## gateway-claude-cpa-window

**Claude launch uses the CPA window for non-manifest models only**

Non-official CPA rows such as Space Bunny and MiMo advertise their window, but Claude ignored it and launched at 200k. Those rows now use the advertised window. First-party manifest ids are left alone: the 200k row, its `[1m]` variant, and Opus 5.5 at 1M. CPA reports the base id as 1M, which would collapse that pair.

```bash
npx vitest run packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts packages/server/src/server/agent/providers/claude/agent.test.ts --bail=1
```

## cliproxyapi-config-name

**first-party routing is `agents.cliproxyapi`, not `gateway`**

The config key is `agents.cliproxyapi`. Env is `PASEO_CLIPROXYAPI_*`. The tooltip says CLIProxyAPI quota. The quota RPC is `cliproxyapi.quota.get`, gated on `server_info.features.cliproxyapiQuota`.

```bash
npx vitest run packages/server/src/server/agent/gateway/config.test.ts packages/server/src/server/persisted-config.test.ts --bail=1
```

## gateway-latest-request

**CLIProxyAPI last-request stats in the context-meter tooltip, polled while it is open**

The `cliproxyapi.stats.get` RPC (gated on `server_info.features.cliproxyapiStats`) reads `/v1/last-request-stats`, and the meter's tooltip renders a "CLIProxyAPI latest request" table next to quota: first token and generating above a rule, then the derived total, throughput, and age. It polls every 3s while the tooltip is open and stops with it, so someone watching throughput sees it move without a closed tooltip costing anything. A missing route, an unrun model, and a bad key all hide the section. CLIProxyAPI renamed the route from `/v1/last-request-tps` to `/v1/last-request-stats` in v8.0.902 with the body unchanged and the old path dropped. Because the feature shipped unreleased, Paseo also renamed its own RPC from `cliproxyapi.tps.get` to `cliproxyapi.stats.get` rather than carry a wire alias forever for a name that was never public.

```bash
npx vitest run packages/server/src/server/agent/gateway/stats.test.ts packages/server/src/server/session/provider/provider-catalog-session.test.ts packages/protocol/src/messages.test.ts --bail=1
cd packages/app && npx vitest run --project unit src/gateway-stats --bail=1
```

## gateway-unmanifested-minor-release

**a first-party minor release the manifest does not list is a gateway row, not a spelling of the major it extends**

`normalizeClaudeRuntimeModelId` folds `claude-sonnet-5-5` onto `claude-sonnet-5` because the fallback match is unanchored. `appendCliproxyModelsToClaudeCatalog` skips every row that normalizes, so a new Anthropic minor release advertised by the Gateway was silently dropped from the Claude catalog and never reached Claude Code. The fallback match now refuses to fold a trailing 1-2 digit minor; a 3+ digit run stays foldable so dated spellings (`claude-opus-5-20260724-v1:0`) still resolve.

```bash
npx vitest run packages/server/src/server/agent/providers/claude/models.test.ts packages/server/src/server/agent/providers/claude/cliproxy-models.test.ts --bail=1
```

## cliproxyapi-terminal-tui-routing

**terminal tabs route harnesses through CLIProxyAPI, via generated shims**

A terminal tab launches harnesses as ordinary child processes, so the agent path never injects gateway routing there. Paseo writes `claude`, `codex`, and `opencode` shims into a shim directory under `$PASEO_HOME` (`harness-shims`, or `cmd-shims` on Windows where the wrappers are `.cmd`) and prepends that directory to terminal PATH; OMP reads `LITELLM_*` from env and needs no shim. Env alone would not do: Codex only accepts its `model_providers` map from argv, and injected env would put three gateway credentials in front of every unrelated process in the shell. Shims are rewritten per terminal create, so a gateway edit reaches new terminals without a daemon restart. `PASEO_CLIPROXYAPI_DISABLE_SHIM=1` bypasses one invocation. Terminal-only by construction — the shim directory never reaches provider env, where the agent path already injects the same routing.

What a terminal gets is routing, not the full launch contract. A Claude terminal receives the endpoint and key only: Claude asks `/v1/models` for a model's id and description, so a Gateway model is one it does not recognise and runs at its 200k default no matter what the Gateway advertises. The agent path sets the window because it knows the model before launch; a TUI session picks afterwards. `ANTHROPIC_CUSTOM_MODEL_OPTION_*` and the Fable naming are likewise agent-path only. Do not read the shims as parity with the agent path — Codex and OpenCode terminals do reach their advertised limits, Claude does not.

```bash
npx vitest run packages/server/src/terminal/harness-shims.test.ts packages/server/src/terminal/harness-shim-writer.test.ts packages/server/src/terminal/harness-routing.test.ts packages/server/src/terminal/worker-terminal-manager.test.ts --bail=1
```

## gateway-codex-catalog-shape

**Gateway-discovered Codex rows are normalized to the `ModelInfo` shapes Codex parses**

Gateway `/v1/models` rows arrive as `supported_reasoning_levels: [{ effort }]` with no `description` and `visibility: []`. Written verbatim into `codex-model-catalog.json`, Codex's app-server rejects the file (`missing field description`, `invalid type: sequence, expected string or map`) and every Codex spawn exits code 1. `normalizeCodexCatalogModel` fills level descriptions from the effort and maps visibility arrays to `"list"`/`"hide"`; `resolveCodexModelCatalogPath` treats stale pre-normalization files as absent so the next Gateway refresh rebuilds them.

```bash
npx vitest run packages/server/src/server/agent/providers/codex-catalog.test.ts --bail=1
```

## gateway-boot-catalog-cache

**the daemon resolves provider catalogs before resuming, and keeps a raw-response gateway cache**

Discovery was lazy, so `autoResumeRunningAgents` ran at boot with an empty catalog: gateway models launched with no `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, Claude Code assumed 200K, and the resumed transcript was compacted against that wrong ceiling. Boot now awaits `refreshSettingsSnapshot` before auto-resume, concurrent with `listen` so the daemon still starts promptly. Catalog responses are cached one file per request URL under `$PASEO_HOME/cache/cliproxyapi/`; a live catalog always wins, the cache stands in only when the gateway returned no models, and having neither logs the 200K assumption instead of failing silently. `PASEO_DISABLE_GATEWAY_CACHE=1` skips the cache and is set by both vitest configs, so no suite writes a gateway cache into a real `$PASEO_HOME`.

```bash
npx vitest run packages/server/src/server/agent/gateway/http-response-cache.test.ts packages/server/src/server/agent/providers/claude/agent.env.test.ts --bail=1
```

## voice-read-aloud-push-to-talk

**replayable Speak history rows, read-aloud on any message, push-to-talk voice input**

Speak tool calls render as collapsed badges (mic icon + "Spoke" + first-line preview, markdown on expand) with a replay button; every completed assistant turn gets one raw + sparkle-rewrite read-aloud pair in the turn footer beside fork/copy (whole-turn text via on-device TTS), the rewrite going through `voice.read_aloud.rewrite` on the custom metadata endpoint only. Voice mode gains a persisted Always / Push-to-talk toggle with client-side transmit gating (chunks dropped unless transmitting, release commits the utterance via `voice_audio_chunk.isLast` + `commitUtterance`).

```bash
npx vitest run packages/protocol/src/messages.voice-read-aloud-rewrite.test.ts --bail=1
npx vitest run packages/server/src/server/session/voice/voice-read-aloud-rewrite.test.ts packages/server/src/server/session/voice/voice-turn-controller.test.ts packages/server/src/server/session/voice/voice-session.test.ts --bail=1
npm test --workspace=@getpaseo/app -- src/components/read-aloud-buttons.test.ts src/voice/read-aloud-player.test.ts src/voice/read-aloud-voice.test.ts src/voice/voice-runtime.test.ts --bail=1
grep -q "voice.read_aloud.rewrite.request" packages/protocol/src/messages.ts
grep -q "commitUtterance" packages/server/src/server/session/voice/voice-turn-controller.ts
grep -q "pushToTalk" packages/app/src/voice/voice-runtime.ts
grep -q "readAloud={readAloud}" packages/app/src/agent-stream/turn-footer.tsx
```

## voice-dictation-ai-polish

**AI-polish button for voice-dictated drafts via the custom metadata endpoint only**

The dictation overlay gains a sparkle-badged polish action next to insert: the raw transcript is confirmed first, polished through `voice.dictation.polish` (custom metadata endpoint only, own faithful-cleanup prompt — never the read-aloud prompt), and the result lands back in the composer for review with send staying manual. Fail-closed like read-aloud: the button hides without the `voiceDictationPolish` host feature.

```bash
npx vitest run packages/protocol/src/messages.voice-dictation-polish.test.ts --bail=1
npx vitest run packages/server/src/server/session/voice/voice-dictation-polish.test.ts --bail=1
npx vitest run packages/client/src/daemon-client.test.ts --bail=1 -t "dictation polish"
npm test --workspace=@getpaseo/app -- src/voice/use-dictation-polish.test.ts src/i18n/resources.test.ts --bail=1
grep -q "voice.dictation.polish.request" packages/protocol/src/messages.ts
grep -q "buildDictationPolishPrompt" packages/server/src/server/session/voice/voice-dictation-polish.ts
grep -q "confirmDictationForPolish" packages/app/src/hooks/use-dictation.ts
```

## mobile-keep-screen-awake

**Keep Screen Awake setting holds a wake lock while the app is open**

`keepScreenAwake` (default on) persists in app settings with a General → Display toggle on native only. KeepScreenAwakeController holds the `paseo:keep-screen-awake` expo-keep-awake tag while the app is open, gated on settings load so opted-out cold starts never flash a transient lock. The tag is distinct from the voice runtime's `paseo:voice`, so toggling the setting never drops a lock an active voice session needs.

```bash
npx vitest run packages/app/src/hooks/use-settings/storage.test.ts --bail=1
npm test --workspace=@getpaseo/app -- src/components/keep-screen-awake-controller.test.tsx src/screens/settings/general/keep-awake-section.test.tsx --bail=1
grep -q "keepScreenAwake" packages/app/src/hooks/use-settings/storage.ts
grep -q "paseo:keep-screen-awake" packages/app/src/components/keep-screen-awake-controller.tsx
grep -q "KeepAwakeSection" packages/app/src/screens/settings-screen.tsx
```

## files-pane-upload

**upload files into the workspace Files pane via toolbar button or drag-drop**

The Files pane toolbar gains an Upload button (system picker) and the pane accepts file drops. The target is the selected folder, else the selected file's parent, else the workspace root; existing names go through confirm-then-overwrite, enforced server-side by the `overwrite` flag with `alreadyExists` on conflict. Transport is `fs.entry.upload.request/response` over the binary file-transfer frames: the daemon stages in `PASEO_HOME/uploads`, then temp-copies onto the destination filesystem and renames over the target, so the original survives a failed replace and the executable bit is preserved. Dropped folders are skipped with a toast. Gated on `server_info.features.fsEntryUpload`, so old daemons hide the button and disable drop.

```bash
npx vitest run packages/server/src/server/file-explorer/service.test.ts packages/server/src/server/session/files/workspace-files-session.test.ts packages/server/src/server/file-upload/index.test.ts --bail=1
npx vitest run packages/client/src/daemon-client.test.ts --bail=1 -t "upload"
npm test --workspace=@getpaseo/app -- src/file-explorer/upload-target.test.ts src/components/file-drop/partition-dropped-files.test.ts src/composer/attachments/drop.test.ts src/i18n/resources.test.ts --bail=1
grep -q "fs.entry.upload.request" packages/protocol/src/messages.ts
grep -q "moveStagedUploadIntoWorkspace" packages/server/src/server/file-explorer/service.ts
grep -q "fsEntryUpload" packages/app/src/components/file-explorer-pane.tsx
```

## scheduled-agent-prompts

**schedule a prompt on any running agent with one-shot timers or calendar cadences**

The composer toolbar gains a Schedule prompt action (CalendarClock icon) beside the Send button. The schedule sheet supports one-shot timer presets ("In 15 minutes", "In 30 minutes", "In 1 hour", "In 2 hours", "In 4 hours", "Tomorrow 9:00") and custom cron, prefilled with the composer draft. On schedule, the composer clears, a confirmation toast appears, and the scheduled prompt appears in the Heartbeats / Scheduled Prompts track above the composer with countdown labels ("in 30m"). Scheduled prompts target the agent with `asUserMessage: true` and `maxRuns: 1`. On fire, the daemon delivers the prompt directly to the agent as a real user message (waiting if an active turn is in-flight) rather than wrapping it in a system notification envelope, so the user's prompt appears in the conversation timeline and the agent runs autonomously. Gated on `server_info.features.scheduledPrompt`.

```bash
npx vitest run packages/protocol/src/schedule/cadence.test.ts packages/protocol/src/schedule/types.test.ts --bail=1
npx vitest run packages/server/src/server/schedule/service.test.ts -t "agent-target schedule" --bail=1
npm test --workspace=@getpaseo/app -- src/schedules/schedule-cadence-options.test.ts src/schedules/schedule-form-model.test.ts src/heartbeats/select.test.ts src/composer/schedule-prompt.test.ts --bail=1
grep -q "scheduledPrompt" packages/protocol/src/messages.ts
grep -q "asUserMessage" packages/server/src/server/schedule/service.ts
grep -q "composer-schedule-button" packages/app/src/composer/input/input.tsx
```

## rate-limit-cooldown-auto-resume

**automatically resume agent sessions after API rate limit and model cooldown recovery**

When API quota exhaustion or model cooldown occurs and a recovery timestamp is known (`RETRY_AFTER:<UTC_DATETIME>`), the daemon schedules a timer to automatically resume the session with `<paseo-system>Resume - rate limit cooldown has ended</paseo-system>` and a `rate_limit_retry` timeline marker. The UI surfaces an active cooldown banner and composer track pill with live countdowns and "Resume now" / "Cancel auto-resume" controls. The feature is enabled by default with a host-level setting (`autoResumeOnRateLimit`) and per-agent tab settings ("Agent settings..." modal, stored in agent labels as `rate_limit_auto_resume`). While a rate limit cooldown timer is active, scheduled agent heartbeats are skipped to avoid redundant provider requests and timeline noise. Pending retries survive daemon restarts via `pending-rate-limit-auto-resumes.json` and are restored before schedules run. `AgentManager.setRateLimitCooldown` publishes only a real change: every turn start cancels auto-resume, and publishing that no-op clear sent an idle snapshot that reached the app after `turn_started`, flickering the running indicator and jumping the timeline 69px.

```bash
npx vitest run packages/server/src/server/agent/agent-rate-limit-auto-resume.test.ts --bail=1
npx vitest run packages/server/src/server/agent/agent-manager.test.ts -t "absent rate-limit cooldown" --config packages/server/vitest.config.ts --bail=1
npx vitest run packages/server/src/server/schedule/service.test.ts -t "agent-target schedule skips execution when rate limit cooldown is active" --bail=1
npm test --workspace=@getpaseo/app -- src/screens/workspace/use-workspace-agent-settings.test.tsx src/components/message-resume-label.test.ts --bail=1
grep -q "autoResumeOnRateLimit" packages/protocol/src/messages.ts
grep -q "rate_limit_retry" packages/protocol/src/agent-types.ts
grep -q "agent-settings" packages/app/src/screens/workspace/workspace-tab-menu.ts
grep -q "RateLimitCooldownBanner" packages/app/src/rate-limit-cooldown/rate-limit-cooldown-banner.tsx
```

## git-remote-poll-quiet

**stop remote git fetch and PR polling after 6 quiet hours**

A workspace directory leaves the 180s `git fetch` and the forge PR retain when it is archived, or when no connected client has it open and its newest non-archived agent `updatedAt` is 6 hours old or older. Exactly 6 hours is out. An open client keeps the directory in the set even when every agent clock is stale. The open workspace is `client_heartbeat.openWorkspaceId`. The focused tab is not a workspace, and a files or git tab sets neither focused id. Old clients omit the field and pin nothing. Boot reads the stored agent records, because `listAgents()` is empty until a session resumes.

```bash
npx vitest run packages/server/src/server/git-remote-poll/git-remote-poll.test.ts --bail=1
grep -q "listAgentsIncludingInternal" packages/server/src/server/bootstrap.ts
```

## precise-relative-time-resets

**dynamic, precise relative time duration for quota resets and usage windows**

Reset and run-out labels keep the next-smaller unit: 24h or more reads days and hours (`1d 5h`), under 24h reads hours and minutes (`5h 30m`), exact boundaries drop the remainder (`1d`, `5h`), under an hour reads minutes (`45m`), and under a minute reads `<1m`. v0.14.0 localized these durations (`providerUsage.duration.*`), so the fork adds a remainder to upstream's `RelativeDuration` and joins the two localized units with a space. `formatPreciseDuration` and `formatCountdownClock` serve the prompt-cache countdowns.

```bash
npm test --workspace=@getpaseo/app -- src/usage/format.test.ts --bail=1
```

## claude-prompt-cache-warming

**automatic prompt cache warming for long-running Claude Code agent sessions**

Cache warm-up keeps a Claude Code session's Anthropic prompt cache alive just before it expires, through a throwaway fork of the session (`ClaudeAgentSession.warmPromptCache`): one request with the session's own launch options plus `resume`, `forkSession`, `persistSession: false` and `maxTurns: 1`, at the lowest effort, thinking off where the model allows it, with no MCP servers, hooks or tools. Nothing reaches the agent, so it warms an idle agent, a running turn and a turn blocked on a question or permission alike, and leaves nothing in the transcript. Measured with Haiku 5.5 on Claude Code 2.1.314 through a logging proxy: the fork read the whole prefix (53,854 tokens) also while the session waited on a permission, MCP servers are deferred tools whose names already sit in the transcript so a fork without them read it all too, and the session's own request 8 minutes after its last, 4 after the fork, still read the whole prefix, so the fork's read restarts the TTL for the session. The warm-up reads the cache figures from the fork's own `message_start` and stops at the first `result` after it. A session whose background tasks (Monitor, `run_in_background`) are still running makes the resumed fork report them first and end that report with an empty `result` (`origin.kind: "task-notification"`, `num_turns: 0`) before the prompt's request starts (Claude Code 2.1.316). Up to v0.14.905 the warm-up stopped at that result, recorded nothing, and so ended the idle stretch after one attempt: a 700k session with Monitors running lost every warm-up and rewrote 679k tokens on its next turn. Until then warm-up sent the agent a natural ping ("AFK for a bit, keeping you alive. Reply with 'ok' only.") as a turn, which needed an idle agent and left a ping and its "ok" in every transcript; `buildTimelinePromptIndex` still keeps such pings out of the chat outline and the stream still renders them as a compact `CacheWarmedMarker`. A session that cannot fork still gets that ping.

- **Only an explicit Cache window can be warmed.** `cache_warm` is listed and honoured only when `prompt_cache_ttl` is `5m` or `1h`; Auto hides it. Auto is Claude Code's choice: 1 hour on a subscription within its limits, 5 minutes on an API key, Bedrock, Vertex, a CLIProxyAPI gateway, or once the account is on overage. Paseo sees that choice only after the fact, in the TTL a cache write is billed at, so it cannot plan a warm-up ahead of the first write. The first version (#134 to #136) assumed Automatic meant 1h for user sessions and 5m for children. That was right for a subscription-only setup and wrong for every gateway or overage session.
- **The countdown starts at the last request, not at turn end.** Anthropic restarts the TTL when it processes a request, and one turn makes many requests. The Claude provider attaches `requestCache` (read, write and uncached tokens, and the write's TTL from `usage.cache_creation`) to the `usage_updated` it emits on each main-thread `message_start`; `AgentManager` stamps it as `promptCache.lastRequest` and keeps the turn's first request as `promptCache.turnFirstRequest`, which the pill shows as the last prompt's cache hit, and `promptCache.observedTtl`, the TTL of the latest write. All three persist on the agent record. Turn end (`lastResponseAt`) is only the fallback for records written before samples existed. Turn end was the first anchor because it was the only timestamp on hand; a long final answer ate the warm-up margin and the ping landed on a dead cache.
- **Timing.** 1h windows warm 58 minutes after the last request, capped at 12 pings per idle stretch; 5m windows warm at 4 minutes, capped at 10, so they cover about 40 idle minutes. They warmed at 4m30s until pings were seen to start 289-290 s after the last request on a 500k context, and some only at 314-322 s, after the window; a ping goes through Claude Code, its prompt hooks and the request's start, so it needs a minute of margin. A real prompt resets the cap; `totalWarmPings` counts every warm-up over the agent's life and never resets; the snapshot carries it, and the insights dialog's Warm-ups tile counts the same warm-up requests over the whole session. Only a request moves the anchor, so a ping that fails or is skipped does not count and stops that idle stretch instead of retrying. The fork runs at the model's lowest effort (`resolveClaudeWarmPingEffort`) with thinking off where the model allows it, set at its launch, because it only has to answer "ok". Measured: a different effort or thinking setting reads the whole cached prefix (Opus 5.5, 73k: low effort read 72,986 and wrote 14; Haiku 5.5 fork with thinking off read 53,938). v0.14.903 lowered the effort of the ping turn itself with `applyFlagSettings({ effortLevel })` and restored it after; that lowered the idle-cap compaction too, which is the only warm-up turn left, so it was removed.
- **Effective TTL.** The countdown, the warm-up timing and the shell cap all run on one TTL: the latest observed write, else the Cache window, else 5m (`resolveEffectivePromptCacheTtl`). The observed write comes first because a Cache window change reaches Claude Code only when its process relaunches, and Automatic is visible only in writes. A relaunch keeps the observation in the provider and in `promptCache.observedTtl` alike: the cached entries keep their TTL until the new process writes, and its first request comes before any tool call. 5m is the fallback because treating a 5m cache as 1h lets it expire unseen.
- **What it waits on.** Through a fork the watchdog warms idle, errored, running and blocked agents, and an open question stays open: a parent agent's or the user's answer still lands in a warm cache. Only the idle-cap compaction is a turn, so it needs an idle agent with nothing pending; otherwise the cap lets the cache expire. Before forks, the ping needed an idle agent, so the watchdog skipped running turns and pending permissions, and denied the user's own unanswered `AskUserQuestion` at the deadline with `CACHE_WARM_QUESTION_PAUSE_MESSAGE` so the turn ended and the ping could go out; that closing, its `promptCache.questionClosedAt` stamp and the "Question closed while you were away" badge remain only for a session that cannot fork. The cost that drove the change: an owner blocked 16 and 30 minutes on its parent's answer rewrote 633k and 657k tokens.
- **Running turns are warmed.** Every request the agent makes restarts the countdown (`AgentCacheWarmManager.onRequestRecorded` re-times the warm-up and ends the idle stretch's count), and a turn that waits on a tool, a subagent, an MCP call or a Monitor is warmed through the fork like an idle agent. A fork's request is a warm-up that belongs to no turn, so the agent's next request still continues its turn (`recordPromptCacheRequest`). The pill and the sidebar count down to the next warm-up during a turn on a host with `server_info.features.cacheWarmFork`; before forks a ping would have queued behind the turn, so the pill showed `cache · expired` when the window passed inside it, and still does on an older host.
- **Foreground shell cap.** A PreToolUse hook (`providers/claude/foreground-shell-cap.ts`, matcher `Bash|PowerShell`) denies a foreground Bash or PowerShell call whose `timeout` exceeds `FOREGROUND_SHELL_CAP_MS` for the effective TTL: 250 s on 5m, 58 minutes on 1h. The reason names the tool, the cap and `run_in_background`; background calls are exempt. Input it cannot read, or a `timeout` that is not a finite number, is denied as well. It denies instead of clamping because Claude Code shortens a requested timeout silently, and a call that reaches its timeout is moved to the background (or stopped where auto-backgrounding is off), so the model never sees a refusal naming the cap. SDK callback hooks still run under `disableAllHooks`, so internal agents are capped too. It is a hook, not a `BASH_MAX_TIMEOUT_MS` env overlay, because Claude Code applies user, project and local settings `env` over the spawn env, and a launch-time value cannot follow the observed TTL. A call with no `timeout` gets Claude Code's default, which the hook cannot see and which PowerShell reads from the same variable, so Paseo pins `BASH_DEFAULT_TIMEOUT_MS=120000` in the flag settings layer, which outranks every settings file except managed policy. Background calls keep Claude Code's 2-hour cap: in Claude Code 2.1.312 the only thing that lowers it to the foreground max is an internal tool-context field (`shellWallCapMs` in the bundle), which no SDK option exposes and Paseo cannot set.
- **Self-started turns.** A turn Claude Code starts by itself (a task notification) ends on the autonomous path, whose run settles after the idle state is published. `AgentManager` re-arms the watchdog once that run settles; before, the watchdog saw the still-tracked run as busy and the cache expired.
- **Restarts.** `AgentCacheWarmManager.bootstrap` arms loaded agents and idle stored agents that are not loaded yet; the warm-up loads them (`ensureAgentLoaded`) and then forks. It runs after boot auto-resume even when auto-resume fails.
- **Request history.** `recordPromptCacheRequest` (protocol) records every main-thread request: its kind (turn start, a later request in the turn, or a warm-up), its read/write/uncached split, the gap since the previous request and, on a turn start, the time since the latest request that was not a warm-up. One entry per request, not per prompt, because each request reads or writes the cache on its own, and a miss in the middle of a turn (a tool call longer than the window) costs as much as a miss on return. A usage report whose read, write and uncached counts are all zero carries no accounting, so it is not an entry. A request is a hit when it read at least 90% of the previous request's input (`PROMPT_CACHE_PREVIOUS_READ_RATIO`, stored as `previousInputTokens`). The cache holds what the previous request sent, so a request that appends a large tool result is still a hit when it reads all of that. The 90% is because an expired cache can still read the shared system prefix, which is most of a small context. Records written before `previousInputTokens` existed fall back to reading at least half of their own input (`PROMPT_CACHE_HIT_RATIO`). A fresh session's first request is never a hit: it has no earlier request to read, even when the API reports a read of the shared system and tool prefix (two fresh QA sessions each read 38,478 tokens on their first request, which is that prefix). A native fork's first request is measured against the last request its parent made before the fork (`PromptCacheInheritance`), because the fork inherits that context and reads it from the cache. A fork started on another model inherits nothing, because a cache belongs to one model, so its first request is a fresh session's. The parent's entry stays warm, and the fork's writes do not evict it. A miss (`isAvoidablePromptCacheMiss`) is a request that came after cached context and was not a hit. A fresh session's first request is neither a hit nor a miss, and the snapshot and chart show it as a neutral first write. The first request after a compaction (`afterCompaction`), at any time, is left out of every count and chart, because the compacted context was never cached; the compaction marks the chart instead. A later user prompt is a miss like any other when the cache had expired. The snapshot carries three things: the latest `PROMPT_CACHE_HISTORY_LIMIT` (24) requests for the pill's bars, the latest compactions, and `promptCache.totals` (requests that had a cache to hit, hits and misses over the whole session, seeded from the window on records written before totals existed). Before the journal it held 60 requests, which was also the only record of the session; that many bars made the popover too large to read, and 60 was still a window, not the session. The whole session now lives in an append-only JSONL journal per agent under `$PASEO_HOME/prompt-cache/` (`agent/prompt-cache-journal.ts`), seeded from the snapshot window the first time an existing agent writes. The insights dialog fetches it with `agent.prompt_cache.history.request`, gated on `server_info.features.promptCacheInsights`. Deleting an agent deletes its journal; archiving keeps it.
- **Misses beside the countdown.** The session's miss count shows in red after a middle dot, in the composer pill (a `tone: "danger"` segment) and on the sidebar workspace row. The count is shown only above zero, so a session with no misses has no red number. The row shows it even with no warm-up armed, because a miss is worth seeing whether or not warm-up is on. The pill, popover and insights work with warm-up off, since requests are recorded either way.
- **Compacting at the idle cap.** When warm-up reaches its cap, the cache used to expire. With compaction on, the watchdog sends `/compact` at the time the next ping would have gone, while the cache is still warm, so the compaction reads the context at the cache price. It then turns warm-up off: the compacted context is cheap to write again, so keeping it warm costs more than it saves. It compacts only when the latest request read at least `CACHE_AUTO_COMPACT_MIN_CONTEXT_TOKENS` (200k) of input: a new Claude Code session starts near 60k, so compacting a smaller context saves little and loses its detail. Below that, or with a question pending, the cache expires as before. The compaction goes out as a warm-up turn, so it raises no attention, but it does not count as a ping. The host setting `daemon.cacheAutoCompact` (Host settings, "Compact at the warm-up cap", off by default) is the default; the pill's "Compact at cap" / "Let it expire" button stores the agent's own choice in `featureValues.cache_auto_compact`, which `AgentManager.setAgentFeature` keeps daemon-side because the Claude provider never sees it. The snapshot carries that explicit choice as `cacheAutoCompact`, and the app resolves it against the host config. The compaction is recorded from the provider's `compaction` timeline item, with `atIdleCap` when it ran inside a warm-up turn. Before the `/compact` is sent, Paseo pauses every schedule whose target is the agent (`create_heartbeat` creates one, so heartbeats are included), and a pause that fails stops the compaction. A warm-up turn is never captured by shutdown auto-resume, so a restart cannot send a resume prompt into it. Claude's own cron and wake-up timers (`CronCreate`, `ScheduleWakeup`) run inside the Claude process, so pausing schedules cannot reach them; the process stops when the compacted cache expires (next bullet).
- **Stopping at expiry.** Once a Claude agent's cache expires (a 5m or 1h Cache window, so the expiry is known; `resolvePromptCacheExpiresAtMs`), nothing automatic may wake it, because the wake-up writes the whole context again at full price. The idle-runtime sweep stops its process at the next minute's check (`cacheExpiresAt` on `RuntimeCleanupCandidate`), even with `agents.idleRuntimeCleanup` off, because Claude's own timers, `/loop` and task notifications run inside that process and only stopping it silences them. An agent heartbeat or schedule run skips it with "Skipped: the agent's prompt cache has expired", and boot auto-resume leaves it alone (`shouldSkipWakeForExpiredCache`). The host setting `daemon.cacheExpiryStop` (Host settings, "When a cache expires") picks the policy: `when-idle` (default, "Keep tasks") keeps a process whose background task still runs, so no work is killed, and that task's notification can still wake it cold; `always` ("Stop all") stops it anyway; `off` leaves processes running and wakes allowed. Messages from other agents, finish notifications included, are still delivered: dropping them would lose hand-offs. The composer shows a dot before the model selector, green while the Claude process runs and hollow while it does not (`composer/agent-controls/runtime-status-dot.tsx`). It reads the snapshot's `runtimeActive`, which the daemon reports for Claude from the session's child process (`hasLiveRuntime`), not the agent status: a loaded agent is `idle` with no process until its first turn, for example after it is opened in the app or after a daemon restart. The next message starts the process again.
- **Model switch confirmation.** Switching a first-party Claude agent's model while warm-up keeps a live cache asks first (`resolveModelSwitchGuard`, `composer/agent-controls/model-switch-confirm.tsx`), because a cache belongs to one model and the new one writes the whole context again. "Switch anyway" switches; "Fork on <model>" native-forks the whole conversation into a new tab on the chosen model (`agent.native_fork.request` with `model`, gated on `server_info.features.nativeForkModel`; a fork with no boundary starts from the latest reply), so this session keeps its cache; Cancel keeps the model. Effort changes do not ask, because they keep the cache.
- **Cold send confirmation.** A message to a first-party Claude agent other than Haiku whose cache has expired asks first (`resolveColdSendGuard`, `prompt-cache/use-cold-send-guard.tsx`). "Send anyway" sends. "Compact on Haiku 5.5, then send" sends the message with `compactFirst` (gated on `server_info.features.compactThenSend`): the daemon admits it as queued, switches the agent to Haiku 5.5 at max effort, runs `/compact`, restores the agent's own model and thinking, each tried even if the other fails, then sends the message (`agent/compact-with-model.ts`), so Haiku re-reads the full context at a fraction of the price and the agent's own model writes only the summary. The message goes out only once a compaction is recorded: one that fails, stops on a permission request, is cancelled or runs past 10 minutes leaves it unsent with an error, because sending would pay the full write the user chose to avoid. The press decides again whether to compact, so a cache made live while the dialog was open is sent without compacting. Slash commands send without asking.
- **Where it shows.** The composer pill and its popover show live countdowns as `m:ss` (a cache window never passes 60 minutes); the idle cap's covered span keeps the quota style (`11h36m`). The sidebar workspace row shows a flame and the same countdown beside the heartbeat while the workspace's active agent has a warm-up armed (warm-up on, idle, under the cap, cache still warm); with nothing armed it shows only the miss count, and nothing when there were no misses. In the chat, each idle stretch's warm-ups are one line under the row they followed, "Cache warmed ×6 · 12:04–12:24", whose count grows as warm-ups land (`prompt-cache/warm-up-stretches.ts`). A fork warm-up has no row of its own, so the app places it by time, from the snapshot's latest requests and, when `totalWarmPings` says the snapshot misses some, from the journal read once per open chat (`use-warm-up-times.ts`). A warm-up sent as a turn on an older session is its own prompt and reply rows; those render nothing and count towards the same line, and the larger of the two counts wins so one warm-up is never counted twice. The chat showed one "Cache warmed up" line per ping turn until warm-ups moved to forks left nothing to show, and counting repeated lines by hand was the complaint that brought the counted line.
- **Choosing at creation.** A new workspace or agent, and a schedule's create and edit form, set the Cache window and Cache warm-up up front. The draft composer sends its chosen feature values to `list_provider_features_request` (`use-draft-agent-features.ts`), because Claude lists `cache_warm` only for a 5m or 1h window; without them the daemon saw Auto and the warm-up toggle never appeared in a draft. The schedule form shows both fields for first-party Claude models (`schedules/schedule-prompt-cache.ts`), starts a new schedule from the window last chosen in the composer, and stores the warm-up as an explicit value so a run does not follow a default that later changes. Editing replaces the schedule's `featureValues` through `newAgentConfig.featureValues`, gated on `server_info.features.scheduleFeatureValues`, because an older daemon strips the field and the edit would be lost silently.
- **Cache window confirmation.** Changing the Cache window asks first only while a live cache has time left. `liveCacheRemainingMs` in `prompt-cache/cache-window-change.ts` decides what counts as live. The dialog in `composer/agent-controls/cache-window-confirm.tsx` shows the live countdown, read from the cache clock each second, and switches to an expired message if the cache runs out while it is open. Cancel leaves the window unchanged. A pending change applies only to the agent it was asked for, and switching agents cancels it (`pendingChangeForAgent`). With no live cache, the change applies at once. A profile apply that sets the window skips the dialog, because the profile is an explicit choice of the whole agent config, so its window applies as written. The dialog says that changing the window may drop the cache, so the next request may write it again. The TTL takes effect when the Claude process starts (`CLAUDE_CODE_PROMPT_CACHE_TTL`), so a change also restarts the process. Samples disagree. A switch from `5m` to `1h` missed while the cache was warm, once. A session reopened at an unchanged `1h` hit the cache, so the restart alone did not miss. A second switch from `5m` to `1h` left the observed TTL at `5m`, so no `1h` write was seen, and the popover could not be read to tell a hit from a write. The `1h` to `5m` direction is untested. The [prompt caching page](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md) lists no TTL change among its invalidators, so the copy says may, not always. The Cache window icon takes the warning color while the cache is live (`composer/agent-controls/cache-window-live.tsx`). The options read `Auto`, `5m`, and `1h`, and both TTL features use their label as the tooltip (`providers/claude/feature-definitions.ts`).
- **Defaults.** A new first-party Claude agent starts with a 1h Cache window (`CLAUDE_NEW_AGENT_PROMPT_CACHE_TTL`, applied in `AgentManager.createAgent` and shown by the draft's `listFeatures`); Auto stays one click away. It was Auto, which left the countdown, warm-up and the expiry guards without a known expiry; an explicit window teaches the choice. Agents created before keep their stored window, and an internal agent or a native fork keeps its own. A 5m window turns warm-up on unless `cache_warm` says otherwise; 1h starts off. Orchestrator-spawned children get `cache_warm: false` stamped when the host setting `daemon.cacheWarmSubagents` (Host settings, "Cache warm-up for child agents") is off.

```bash
npx vitest run packages/server/src/server/agent/agent-cache-warm.test.ts --config packages/server/vitest.config.ts --bail=1
npx vitest run packages/server/src/server/agent/timeline-prompt-index.test.ts --config packages/server/vitest.config.ts --bail=1
npx vitest run packages/protocol/src/agent-cache-warm.test.ts --bail=1
npx vitest run packages/app/src/prompt-cache/warm-up-stretches.test.ts --config packages/app/vitest.config.ts --bail=1
npx vitest run packages/server/src/server/agent/providers/claude/agent.test.ts -t "cache_warm feature|relaunches the query|per-request|foreground Bash cap|TTL a cache write" --config packages/server/vitest.config.ts --bail=1
npx vitest run packages/server/src/server/agent/agent-manager.test.ts -t "cache|closed question" --config packages/server/vitest.config.ts --bail=1
npx vitest run packages/server/src/server/agent/create-agent/create.test.ts -t "cache_warm" --config packages/server/vitest.config.ts --bail=1
npm --prefix packages/app run test -- src/composer/agent-controls/utils.test.ts src/composer/agent-controls/cache-window-confirm.test.tsx src/composer/agent-controls/cache-window-live.test.tsx src/prompt-cache/cache-window-change.test.ts
npm --prefix packages/app run test -- src/usage/format.test.ts
npm --prefix packages/app run test -- src/prompt-cache/use-workspace-cache-warm.test.ts src/components/sidebar/workspace-meta-row/meta-items.test.ts
npm --prefix packages/app run test -- src/prompt-cache/use-prompt-cache.test.ts
npm --prefix packages/app run test -- src/prompt-cache/prompt-cache-pill.test.tsx src/prompt-cache/prompt-cache-history.test.ts
npx vitest run packages/server/src/server/agent/prompt-cache-journal.test.ts --config packages/server/vitest.config.ts --bail=1
npm --prefix packages/app run test -- src/hooks/use-draft-agent-features.test.tsx src/schedules/schedule-prompt-cache.test.ts
npm --prefix packages/app run test -- src/schedules/schedule-form-model.test.ts -t "prompt cache"
npx vitest run packages/server/src/server/schedule/service.test.ts -t "feature values" --config packages/server/vitest.config.ts --bail=1
grep -q "CLAUDE_CACHE_WARM_FEATURE_ID" packages/server/src/server/agent/providers/claude/feature-definitions.ts
grep -q "CACHE_WARM_FEATURE_ID" packages/app/src/agent-controls/policy.ts
npx vitest run packages/server/src/server/agent/providers/claude/agent.test.ts -t "throwaway fork|orphaned background tasks|nothing to warm" --config packages/server/vitest.config.ts --bail=1
npx vitest run packages/server/src/server/agent/idle-runtime-cleanup/idle-runtime-cleanup.test.ts --config packages/server/vitest.config.ts --bail=1
npx vitest run packages/server/src/server/schedule/service.test.ts -t "prompt cache has expired" --config packages/server/vitest.config.ts --bail=1
npx vitest run packages/server/src/server/agent/agent-auto-resume.test.ts -t "prompt cache has expired" --config packages/server/vitest.config.ts --bail=1
npx vitest run packages/server/src/server/agent/agent-manager.test.ts -t "another model as a fresh session|compacts on another model|original model is rejected|compaction that never ran|fork warm-up" --config packages/server/vitest.config.ts --bail=1
npm --prefix packages/app run test -- src/prompt-cache/cache-guards.test.ts
grep -q "withNewAgentPromptCacheTtl" packages/server/src/server/agent/agent-manager.ts
grep -q "RuntimeStatusDot" packages/app/src/composer/agent-controls/index.tsx
grep -q "useColdSendGuard" packages/app/src/composer/index.tsx
```

## short-history-autoload

**load older history when the chat is too short to scroll**

History-start pagination starts dormant and waits for scroll intent, so opening an agent does not walk its history. When the rendered tail fits the viewport there is nothing to scroll, and Android delivers no drag events to an unscrollable list, so the chat stayed stuck on its tail. Ten cache warm-ups in a row do this: each renders one `CacheWarmedMarker` row and hides its reply. `contentFitsViewport` lets a dormant list load without intent on native; the existing settle loop then keeps loading until the content overflows or history runs out. Web passes `false`: its wheel listener rearms pagination on an unscrollable list, and auto-loading there broke official's `turn-collapse` spec, where a collapsed long turn fits the viewport and history must wait for the user's scroll.

Two races stranded the same list after a cold start, reproduced on the Android emulator in 3 of 5 reopens after warm-ups ran with the app closed:

- The cached timeline renders first and is stored without `hasOlder`, so revealing it latched pagination at history start before the daemon's tail arrived. The latch now records its progress key, and an unscrollable list loads again once the key changes.
- That load is a local reveal from the list's effect, which runs before `useStreamHistoryWindow`'s reconcile effect in the same commit. Reconcile used the boundary index of the window the render saw, judged the revealed boundary missing, and reset it, leaving pagination in `loading` forever. It now looks the boundary up in the window it updates.

```bash
npm --prefix packages/app run test -- src/agent-stream/history-start-pagination.test.ts -t "too short to scroll|latch was set at an older position"
npm --prefix packages/app run test -- src/agent-stream/use-stream-history-window.test.tsx -t "same commit"
```

## website-changelog-official-only

**the website changelog lists official releases only**

The fork records its own releases (`x.y.9NN`) in `CHANGELOG.md`, and its GitHub release notes come from there. v0.14.0's website renders that file, now with a Chinese translation beside it, and shows an untranslated notice for every release missing from `CHANGELOG.zh-CN.md`. Fork entries have no translation, so `packages/website/src/changelog.ts` drops `x.y.9NN` versions before rendering.

```bash
npx vitest run packages/website/src/changelog.test.ts --bail=1 -t "fork releases"
```

## autocomplete-popover-remeasure

**autocomplete popover measures again until its anchor is laid out**

A measurement that comes back empty, because the portal host is not registered yet or the anchor is not laid out, is taken again on the next frame. Upstream drops it, and nothing measures again until the anchor resizes, so a popover opened during a slow load stayed unmounted. The proof renders the popover with its first two measurements empty and expects it to mount without a resize.

```bash
npm test --workspace=@getpaseo/app -- src/components/ui/autocomplete-popover.test.tsx --bail=1
```

## git-fallback-test-waits-for-refresh

**the structural-fallback git test waits for the first refreshes to finish**

`workspace-git-service.test.ts` "$name takes the repository-wide structural fallback" released the fetch once both first refreshes had started. On a slow Windows runner one was still running; the fallback refresh joined that refresh's loop, which ran it only after a timer the test advances once, so it saw 3 snapshots instead of 4. The test now waits until no refresh is in flight before releasing the fetch, and its first snapshot takes 50 ms of real time, so the race happens on every run and without the wait all three cases fail with the CI error. The product is right: in real time that timer fires.

```bash
npx vitest run packages/server/src/server/workspace-git-service.test.ts -t "structural fallback" --config packages/server/vitest.config.ts --bail=1
grep -q "realSetTimeout(resolve, 50)" packages/server/src/server/workspace-git-service.test.ts
```
