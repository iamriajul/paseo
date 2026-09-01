import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { DownloadTokenStore } from "../file-download/token-store.js";
import type { ProjectRegistry } from "../workspace-registry.js";
import { TaskStore } from "./task-store.js";

interface TaskSessionHost {
  emit: (message: SessionOutboundMessage) => void;
}

export class TaskSession {
  constructor(
    private readonly options: {
      host: TaskSessionHost;
      store: TaskStore;
      projectRegistry: ProjectRegistry;
      downloadTokenStore: DownloadTokenStore;
    },
  ) {}

  async handleList(request: Extract<SessionInboundMessage, { type: "tasks.list.request" }>) {
    try {
      await this.requireProject(request.projectId);
      this.options.host.emit({
        type: "tasks.list.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tasks: await this.options.store.list(request.projectId),
          error: null,
        },
      });
    } catch (error) {
      this.options.host.emit({
        type: "tasks.list.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tasks: [],
          error: getErrorMessage(error),
        },
      });
    }
  }

  async handleListAll(request: Extract<SessionInboundMessage, { type: "tasks.list_all.request" }>) {
    try {
      const activeProjectIds = new Set(
        (await this.options.projectRegistry.list())
          .filter((project) => !project.archivedAt)
          .map((project) => project.projectId),
      );
      this.options.host.emit({
        type: "tasks.list_all.response",
        payload: {
          requestId: request.requestId,
          tasks: await this.options.store.listAll(activeProjectIds),
          error: null,
        },
      });
    } catch (error) {
      this.options.host.emit({
        type: "tasks.list_all.response",
        payload: {
          requestId: request.requestId,
          tasks: [],
          error: getErrorMessage(error),
        },
      });
    }
  }

  async handleCreate(request: Extract<SessionInboundMessage, { type: "tasks.create.request" }>) {
    try {
      await this.requireProject(request.projectId);
      const title = requireNonEmptyTitle(request.title);
      const task = await this.options.store.create({
        projectId: request.projectId,
        title,
        description: request.description,
        uploads: request.attachments ?? [],
      });
      this.options.host.emit({
        type: "tasks.create.response",
        payload: { requestId: request.requestId, task, error: null },
      });
    } catch (error) {
      this.options.host.emit({
        type: "tasks.create.response",
        payload: { requestId: request.requestId, task: null, error: getErrorMessage(error) },
      });
    }
  }

  async handleUpdate(request: Extract<SessionInboundMessage, { type: "tasks.update.request" }>) {
    try {
      await this.requireProject(request.projectId);
      const title = request.title === undefined ? undefined : requireNonEmptyTitle(request.title);
      const task = await this.options.store.update({
        projectId: request.projectId,
        taskId: request.taskId,
        ...(title !== undefined ? { title } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.status !== undefined ? { status: request.status } : {}),
      });
      this.options.host.emit({
        type: "tasks.update.response",
        payload: {
          requestId: request.requestId,
          task,
          error: task ? null : `Task not found: ${request.taskId}`,
        },
      });
    } catch (error) {
      this.options.host.emit({
        type: "tasks.update.response",
        payload: { requestId: request.requestId, task: null, error: getErrorMessage(error) },
      });
    }
  }

  async handleDelete(request: Extract<SessionInboundMessage, { type: "tasks.delete.request" }>) {
    try {
      await this.requireProject(request.projectId);
      const deleted = await this.options.store.delete({
        projectId: request.projectId,
        taskId: request.taskId,
      });
      this.options.host.emit({
        type: "tasks.delete.response",
        payload: {
          requestId: request.requestId,
          taskId: request.taskId,
          error: deleted ? null : `Task not found: ${request.taskId}`,
        },
      });
    } catch (error) {
      this.options.host.emit({
        type: "tasks.delete.response",
        payload: {
          requestId: request.requestId,
          taskId: request.taskId,
          error: getErrorMessage(error),
        },
      });
    }
  }

  async handleAttachmentDownloadToken(
    request: Extract<SessionInboundMessage, { type: "tasks.attachment.download_token.request" }>,
  ) {
    try {
      await this.requireProject(request.projectId);
      const attachment = await this.options.store.getAttachment({
        projectId: request.projectId,
        taskId: request.taskId,
        attachmentId: request.attachmentId,
      });
      if (!attachment) {
        throw new Error("Attachment not found");
      }
      const token = this.options.downloadTokenStore.issueToken({
        path: attachment.absolutePath,
        absolutePath: attachment.absolutePath,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
      });
      this.options.host.emit({
        type: "tasks.attachment.download_token.response",
        payload: {
          requestId: request.requestId,
          taskId: request.taskId,
          attachmentId: request.attachmentId,
          token: token.token,
          path: attachment.absolutePath,
          fileName: token.fileName,
          mimeType: token.mimeType,
          size: token.size,
          error: null,
        },
      });
    } catch (error) {
      this.options.host.emit({
        type: "tasks.attachment.download_token.response",
        payload: {
          requestId: request.requestId,
          taskId: request.taskId,
          attachmentId: request.attachmentId,
          token: null,
          path: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async requireProject(projectId: string): Promise<void> {
    const project = await this.options.projectRegistry.get(projectId);
    if (!project || project.archivedAt) {
      throw new Error(`Project not found: ${projectId}`);
    }
  }
}

function requireNonEmptyTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Task title is required");
  }
  return trimmed;
}
