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

**persist PDF bytes and render PdfPreview in the file pane**

application/pdf files persist as preview media like images and FilePreviewBody mounts PdfPreview instead of binaryPreviewUnavailable

```bash
npx vitest run packages/app/src/file-explorer/pdf.test.ts --bail=1 -t "persists images and PDFs"
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

```bash
npx vitest run packages/app/src/components/markdown/fence/mermaid/source-policy.test.ts --bail=1
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

```bash
npx vitest run packages/app/src/panels/panel-manifest.test.ts packages/app/src/workspace-tabs/launcher/internal/catalog.test.ts --bail=1
```

## pdf-daemon-mime

**daemon classifies .pdf as application/pdf with bytes**

file-explorer reads PDF as binary application/pdf so the client persist/mount patch has bytes to preview

```bash
npx vitest run packages/server/src/server/file-explorer/service.test.ts --bail=1 -t "identifies PDF files"
```

## guest-webview-focus

**guest webview and Electron OS focus count as in-app**

getIsAppActivelyVisible treats focused WEBVIEW/IFRAME and BrowserWindow.isFocused as looking at Paseo so Code Server does not yank chat

```bash
npx vitest run packages/app/src/utils/app-visibility.test.ts --bail=1 -t guest
```

## codex-quota-reset

**Settings can reset Codex credits**

Settings quota card resets Codex credits; resetQuota bumps generation so a pre-reset in-flight list is not shown as current usage

```bash
npx vitest run packages/server/src/services/quota-fetcher/service.test.ts --bail=1
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

input-draft keeps host ui_state sync so composer text survives switching devices

```bash
npx vitest run packages/app/src/composer/draft/input-draft.test.ts packages/app/src/ui-state/composer-host-sync.test.ts packages/protocol/src/ui-state/schemas.test.ts --bail=1
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
npx vitest run packages/server/src/server/agent/provider-registry-wrap.test.ts packages/protocol/src/messages.steer.test.ts packages/protocol/src/messages.active-turn-behavior.test.ts packages/app/src/composer/actions.test.ts packages/server/src/server/agent/providers/omp/agent.test.ts --bail=1
```

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

workspace-scoped todo checklist with Apple Notes style UI, Explorer sidebar tab, left sidebar progress indicator, and composer pill. Default Explorer focus stays Changes so Cmd+E matches official; the extra Todo tab would otherwise become the last-tab default.

v0.7.0 plugin navigation imports expo-router from the registry. Root `npx vitest` does not apply the app vitest config (JSX transform, `__DEV__`, expo-router mock), so run these through the app workspace.

```bash
npm test --workspace=@getpaseo/app -- src/todos/workspace-todo-store.test.ts src/todos/workspace-todo-pane.test.tsx src/composer/todo-pill.test.tsx src/panels/agent-tracks.test.ts src/components/sidebar/workspace-meta-row/meta-items.test.ts src/components/sidebar/display-preferences/row-items.test.ts src/workspace-tabs/explorer-sidebar.test.ts src/stores/panel-store/state.test.ts src/stores/workspace-layout-store.test.ts src/i18n/resources.test.ts --bail=1
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

parented Claude agents created via create_agent default featureValues.prompt_cache_ttl=5m; explicit caller value wins verbatim; non-parented and non-Claude agents untouched; buildOptions maps the value onto the SDK env via CLAUDE_CODE_PROMPT_CACHE_TTL (5m/1h set it, default/missing/invalid unset, user env wins); prompt_cache_ttl select feature visible only when stamped; setFeature validates against default/5m/1h

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

resume agents that were running when daemon shut down unexpectedly (SIGTERM/powercut/UPS) by sending 'Resume - there was a power cut' on next boot; intentional daemon stop via client_shutdown_rpc skips

```bash
npx vitest run packages/server/src/server/agent/agent-auto-resume.test.ts --bail=1
```

## agent-notification-restore-after-restart

**a parent hears from its children again after the daemon restarts**

`setupFinishNotification` holds its subscription in daemon memory and nothing persists the child's `notifyOnFinish` choice — the parent link exists only as the child's parent-agent label. Any daemon restart therefore left every parent permanently deaf: children finished, asked for permission, or got closed and no notification arrived, so the parent sat waiting on work that had already landed. `restoreFinishNotifications` walks stored records at boot and re-arms every child whose parent is still unarchived. It runs on every boot, not just after a power cut, and it sits ahead of the auto-resume sweep's early returns so an intentional restart restores too.

The fix is in `setupFinishNotification`, not in the restore. Its closing guard treated a missing child snapshot as "gone" and unsubscribed on the same line it subscribed — but agents restore lazily, so after a restart every stored child has no snapshot yet, and the parent went deaf with no error anywhere. `allowUnloadedChild` splits the two cases the guard was conflating: an absent snapshot means "not loaded yet", while `lifecycle: "closed"` and a deleted agent mean gone and still stop the watch immediately. The restore arms straight from stored records and never loads an agent, so no provider session is resumed just to keep a subscription alive.

```bash
grep -q 'restoreFinishNotifications' packages/server/src/server/agent/agent-prompt.ts packages/server/src/server/agent/agent-auto-resume.ts
grep -q 'allowUnloadedChild' packages/server/src/server/agent/agent-prompt.ts
grep -q 'record.lastStatus === "closed"' packages/server/src/server/agent/agent-prompt.ts
npx vitest run packages/server/src/server/agent/agent-prompt.test.ts --bail=1
```

## agent-auto-resume-system-envelope

**the resume prompt is a system injection, not a user turn**

The auto-resume prompt used to dispatch as an ordinary `user_message`, so the app drew it as a bubble that looked like the user had typed it, and the agent treated it as a request. It now goes through `formatSystemNotificationPrompt`, the same `<paseo-system>` envelope chat mentions and finish notifications already use, which `isSystemInjectedEnvelope` suppresses from the live stream, history replay, and timeline persistence. The human-facing record of the restart is the resume marker above, which is what carries `interruptedAt`. `DEFAULT_AUTO_RESUME_PROMPT` stays the public, configurable string, so `daemon.autoResumeRunningAgents.prompt` and `PASEO_AUTO_RESUME_PROMPT` keep working unchanged.

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

browser-preview rewrites text/html responses to splice a navigation, eruda and element-selector bridge into `<head>`; the web Browser pane drives it over postMessage for history, URL sync, devtools and element attachments. The pane itself lives in fork-owned `web-pane.tsx`, with upstream's `index.web.tsx` reduced to a shim that renders it. Every surface that opens a Browser tab is gated on `useWorkspaceBrowserAvailability`, not `getIsElectron()` — the resolver already answered true for web with a preview template and for Android with a tunnel, while the call sites hard-coded Electron and made the feature unreachable. Nothing is added to `server_info`; the injected script announces itself with a `ready` message, so `packages/protocol` is untouched.

```bash
npx vitest run packages/server/src/server/browser-preview/html-injection.test.ts packages/server/src/server/browser-preview/inject packages/app/src/desktop/browser/pane/web-bridge.test.ts packages/app/src/desktop/browser/pane/web-navigation.test.ts packages/app/src/desktop/browser/pane/web-submit.test.ts packages/app/src/desktop/browser/pane/web-pane.test.tsx --bail=1
grep -q "createHtmlInjectionStream" packages/server/src/server/browser-preview/index.ts
grep -qF 'from "./web-pane"' packages/app/src/desktop/browser/pane/index.web.tsx
grep -q "showCreateBrowserTab = useWorkspaceBrowserAvailability" packages/app/src/screens/workspace/workspace-screen.tsx
grep -q "hasWorkspaceBrowser = useWorkspaceBrowserAvailability" packages/app/src/command-center/workspace-registration.tsx
! grep -q "showCreateBrowserTab = getIsElectron()" packages/app/src/screens/workspace/workspace-screen.tsx
! grep -q "persistenceKey || !getIsElectron()" packages/app/src/screens/workspace/workspace-screen.tsx
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

## playwright-eight-shards-one-worker

**the browser e2e runs on eight shards with one worker each, instead of four shards with two**

Upstream runs `4 shards × 2 workers`. Each worker owns a daemon and a Chromium and shares one Metro, so two workers oversubscribe a standard runner. The symptom was not one bad test: across six consecutive CI runs, five or six _different_ specs failed attempt 1 each time, rotating — `changes-pane`, `composer-autocomplete`, `workspace-navigation-regression`, `sessions-search*`, `new-workspace-launch-memory`. `retries: 1` hid most of them and turned whichever failed twice into a red job.

The evidence is timing, not logic: `sessions-search-hosts:45` took 7.0m on attempt 1 and 29.1s on its retry, and `new-workspace-launch-memory:51` runs in 16.8s on 16 cores, 38.4s pinned to two, and failed CI at 48.8s — its assertions time out at 30s while the test budget is 90s, so a slow runner fails an inner wait before the test itself expires.

Eight single-worker shards keep total concurrency at eight while halving the load each runner carries, and leave wall clock roughly where it was.

```bash
grep -q 'E2E_WORKERS: "1"' .github/workflows/ci.yml
grep -q 'PLAYWRIGHT_SHARD: "8/8"' .github/workflows/ci.yml
! grep -q 'PLAYWRIGHT_SHARD: "1/4"' .github/workflows/ci.yml
```

## archive-responds-before-cleanup

**workspace archive answers on the record, not on disk cleanup**

archive_workspace_request resolves once archivedAt is durable and runs paseo.json worktree.teardown plus the directory removal in the background, so a slow teardown no longer pushes the reply past the client's 60s RPC timeout and the client no longer restores a workspace the daemon archived; the archived state is published before the slow phase so other clients converge, the settling emit still runs after it, and teardown commands are bounded by PASEO_WORKTREE_TEARDOWN_TIMEOUT_MS (default 10 minutes) with the timeout named in the failure

```bash
npx vitest run --config packages/server/vitest.config.ts packages/server/src/server/workspace-archive-service.test.ts packages/server/src/server/session.workspaces.test.ts packages/server/src/utils/worktree.posix.test.ts --bail=1
```

## fork-apk-setup-android-packages

**the fork APK release installs only `platform-tools`, not the removed `tools` package**

`android-actions/setup-android@v3` defaults to `packages: 'tools platform-tools'`, but Google removed the obsolete `tools` package from the SDK repository, so the default invocation dies with "Failed to find package 'tools'" (red since mid-September, including pre-sync main). The Gradle/Expo APK build only needs what the runner image already preinstalls plus `platform-tools`.

```bash
grep -q "packages: platform-tools" .github/workflows/android-apk-release.yml
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

Gateway-routed custom models disallow `WebSearch` (the Gateway does not serve it for non-Anthropic models), gate image blocks on known `inputModalities` with a file-hint fallback, merge auto-persisted limits (now including modalities) into the running client's in-memory models so the first post-discovery session launches with resolved capacity.

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

```bash
npx vitest run packages/server/src/server/agent/providers/codex-catalog.test.ts packages/server/src/server/agent/gateway/models.test.ts --bail=1
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

**per-model Gateway quota in the composer tooltip, hidden when unsupported**

The `gateway.quota.get` RPC (gated on `server_info.features.gatewayQuota`) maps the agent's Paseo model id to a Gateway slug and fetches `/v1/quota`, cached 60 seconds, only for Gateway-routed providers. Old Gateways without the route answer empty-body 404s; those and every other failure return `supported: false` and the tooltip renders nothing instead of an error.

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

## foreign-agent-tab-isolation

**isolate agent tabs and pins to their owning workspace**

Workspace tab reconciliation checks known foreign agents (`foreignAgentIds`) and prunes them from `pinnedAgentIds` and visible tabs so cross-workspace leaks cannot persist. Route open-intent consumption in `HostWorkspaceRouteContent` requires screen focus and redirects foreign agent open intents to their authoritative workspace instead of pinning them into the active workspace.

```bash
npm test --workspace=@getpaseo/app -- src/stores/workspace-layout-store.test.ts src/workspace-tabs/agent-visibility.test.ts --bail=1
```

## gateway-boot-catalog-cache

**the daemon resolves provider catalogs before resuming, and keeps a raw-response gateway cache**

Discovery was lazy, so `autoResumeRunningAgents` ran at boot with an empty catalog: gateway models launched with no `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, Claude Code assumed 200K, and the resumed transcript was compacted against that wrong ceiling. Boot now awaits `refreshSettingsSnapshot` before auto-resume, concurrent with `listen` so the daemon still starts promptly. Catalog responses are cached one file per request URL under `$PASEO_HOME/cache/cliproxyapi/`; a live catalog always wins, the cache stands in only when the gateway returned no models, and having neither logs the 200K assumption instead of failing silently. `PASEO_DISABLE_GATEWAY_CACHE=1` skips the cache and is set by both vitest configs, so no suite writes a gateway cache into a real `$PASEO_HOME`.

```bash
npx vitest run packages/server/src/server/agent/gateway/http-response-cache.test.ts packages/server/src/server/agent/providers/claude/agent.env.test.ts --bail=1
```

## voice-read-aloud-push-to-talk

**replayable Speak history rows, read-aloud on any message, push-to-talk voice input**

Speak tool calls render as collapsed badges (mic icon + "Spoke" + first-line preview, markdown on expand) with a replay button; every completed assistant message gets raw + sparkle-rewrite read-aloud buttons via on-device TTS, the rewrite going through `voice.read_aloud.rewrite` on the custom metadata endpoint only. Voice mode gains a persisted Always / Push-to-talk toggle with client-side transmit gating (chunks dropped unless transmitting, release commits the utterance via `voice_audio_chunk.isLast` + `commitUtterance`).

```bash
npx vitest run packages/protocol/src/messages.voice-read-aloud-rewrite.test.ts --bail=1
npx vitest run packages/server/src/server/session/voice/voice-read-aloud-rewrite.test.ts packages/server/src/server/session/voice/voice-turn-controller.test.ts packages/server/src/server/session/voice/voice-session.test.ts --bail=1
npm test --workspace=@getpaseo/app -- src/components/read-aloud-buttons.test.ts src/voice/read-aloud-player.test.ts src/voice/read-aloud-voice.test.ts src/voice/voice-runtime.test.ts --bail=1
grep -q "voice.read_aloud.rewrite.request" packages/protocol/src/messages.ts
grep -q "commitUtterance" packages/server/src/server/session/voice/voice-turn-controller.ts
grep -q "pushToTalk" packages/app/src/voice/voice-runtime.ts
```
