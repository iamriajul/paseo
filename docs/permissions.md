# Daemon permissions

The daemon authorizes principals with semantic permissions. RPC names and protocol namespaces are not authority.

## Model

```text
principal -> grants
    |
    +-- authenticated by a device or service credential
    `-- opens a session with equal or narrower authority
```

A principal is the durable identity the daemon authorizes. A credential proves that a device or service represents it. Keep them separate so you can rotate credentials, attach more than one device, and revoke a Hub user without inventing daemon user accounts.

A pairing invitation is neither. It is an expiring, single-use exchange that creates a principal and credential with the permissions selected by its issuer.

## Permissions

| Permission          | Authority                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| `daemon.read`       | Daemon status, diagnostics, configuration, and provider information        |
| `daemon.manage`     | Restart, update, configuration changes, providers, skills, and plugins     |
| `tunnel.manage`     | Relay, Hub, service tunnel, and public endpoint relationships              |
| `access.manage`     | Pairing invitations, principals, credentials, grants, and revocation       |
| `workspace.read`    | Projects, workspaces, agents, timelines, files, diffs, and terminal output |
| `workspace.write`   | Prompts, agent control, files, terminals, git operations, and scripts      |
| `workspace.manage`  | Create, rename, archive, and remove projects and workspaces                |
| `automation.manage` | Schedules, heartbeats, and loops                                           |
| `hub.execute`       | Agent lifecycle, workspace titling, observation, and recovery              |

Agents and terminals use workspace authority. Both can execute code and mutate the workspace, so separate write permissions would claim an isolation boundary the daemon cannot enforce.

Connected-host management uses `tunnel.manage`; source-owned connection and metadata replacement
requires the producer or `access.manage`. Routed operations retain both caller and link authority,
see [Connected hosts](connected-hosts.md#ownership-and-authority).

Owner, operator, and viewer are UI presets expanded into explicit permissions. Do not persist them as roles. Adding a permission must not silently widen an existing principal.

Permissions are additive allows. Missing authority denies the operation. Do not add deny precedence.

## Resources

Permissions are daemon-wide today. Future grants may select workspaces or agents, but operation classification remains inside the authorization module:

```ts
type Grant = {
  permission: Permission;
  resource: { kind: "daemon" } | { kind: "workspace"; ids: string[] };
};
```

A delegating principal can grant only authority it already possesses. A session may attenuate its principal's grants but cannot widen them.

Workspace-scoped grants require every resource-bearing operation and outbound observation to enforce the same workspace boundary. File preview, folder listing and image thumbnails accept any daemon-readable path under `workspace.read`, so they must gain resource enforcement before workspace-specific access ships.

## Reading and changing files outside a workspace

File requests carry a client-chosen root (`cwd`), not a workspace id, so the root is not authority. The rule is:

| Operation                                                                                                | Permission        | Where it may reach                                                          |
| -------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| Preview a file, list a folder (`file_explorer_request`), thumbnail an image (`fs.thumbnail.get.request`) | `workspace.read`  | Any daemon-readable path, inside the root it names                          |
| Create, rename, duplicate, delete or upload in the Files panel (`fs.entry.*`)                            | `workspace.write` | Only roots inside an active workspace's directory, after resolving symlinks |
| Save a file from its editor tab (`fs.file.write.request`)                                                | `workspace.write` | The file the user opened, wherever it is                                    |

Listing a folder outside the workspace is consistent with previewing a single file there, which `workspace.read` already allowed, so it adds no authority. The Files panel shows such folders read-only, and the daemon refuses its entry changes there with "Folders outside the workspace are read-only" (`OUTSIDE_WORKSPACE_READ_ONLY_MESSAGE` in `packages/server/src/server/session/files/workspace-files-session.ts`) for any client, not just ours. This is a safety rule against changing the wrong tree, not an isolation boundary: an agent or terminal with `workspace.write` can already write anywhere the daemon can. Editor saves outside the workspace keep working because opening a file from a chat link and editing it predates the switcher.

## Hub

The Hub authenticates as a service principal. Its locally selected grants decide whether it may execute agents, manage the daemon, manage tunnels, or manage access.

Hub user and role identifiers remain opaque external subjects. The Hub may create and revoke linked daemon principals when granted `access.manage`; the daemon does not interpret accounts, organizations, or roles.

Hub enrollment and permission updates exchange these semantic permissions directly. Legacy persisted Hub relationships that contain `hub.execution.*` migrate once to `hub.execute` when the daemon loads them; new relationships never persist or emit transport scopes as authority.
