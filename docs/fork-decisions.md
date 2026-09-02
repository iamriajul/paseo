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

## find-in-chat

**Find in chat: Cmd/Ctrl+F, backfill older history**

agent.search keyboard bindings dispatch Find in chat; agent-panel remounts useChatHistorySearch; loadAllOlder backfills so Cmd/Ctrl+F searches the full transcript

```bash
npx vitest run packages/app/src/keyboard/route-shortcut.test.ts packages/app/src/agent-search/chat-history-search.test.ts --bail=1
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

neutralizeDisallowedTags replaces disallowed tag opens with U+2039 before containsUnsafeMermaidSource so prose like <canonical URL> does not discard the whole diagram; real tags still fail closed; url() check requires word boundary. Do not rewrite a trailing `<i`/`<br` prefix — v0.7.2 streams those labels and a mid-tag ‹ swap clears the SVG. An unclosed `<i>` is still unsafe (mock streaming splits `Done["<i>Done</i>"]` into 4-char slices).

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

**per-browser partitions, tcpTunnel, and localhost links open in workspace Browser**

each Browser tab uses persist:paseo-browser-${browserId}; daemon advertises tcpTunnel and mounts browser-preview before the service proxy; assistant localhost links open in that workspace Browser instead of the client machine

```bash
npx vitest run packages/desktop/src/features/browser-profile.test.ts packages/desktop/src/features/browser-webviews/index.test.ts packages/app/src/utils/localhost-url.test.ts --bail=1
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

left-sidebar keeps a Backlog entry with add-task; buildBacklogRoute stays the /backlog deep link

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

workspace menu exposes Mark as unread when a workspace is done; daemon marks non-running agents with attention to surface in attention group

```bash
npx vitest run packages/protocol/src/messages.workspaces.test.ts packages/server/src/server/session.workspaces.test.ts packages/client/src/daemon-client.test.ts packages/app/src/hooks/use-clear-workspace-attention.test.ts --bail=1
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
