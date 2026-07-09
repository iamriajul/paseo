import { z } from "zod";
import { TaskCardSchema } from "./types.js";

export const TaskUploadedFileAttachmentSchema = z.object({
  type: z.literal("uploaded_file"),
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  path: z.string(),
});
export type TaskUploadedFileAttachment = z.infer<typeof TaskUploadedFileAttachmentSchema>;

export const TaskListRequestSchema = z.object({
  type: z.literal("tasks.list.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
});

export const TaskListResponseSchema = z.object({
  type: z.literal("tasks.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    tasks: z.array(TaskCardSchema),
    error: z.string().nullable(),
  }),
});

export const TaskListAllRequestSchema = z.object({
  type: z.literal("tasks.list_all.request"),
  requestId: z.string(),
});

export const TaskListAllResponseSchema = z.object({
  type: z.literal("tasks.list_all.response"),
  payload: z.object({
    requestId: z.string(),
    tasks: z.array(TaskCardSchema),
    error: z.string().nullable(),
  }),
});

export const TaskCreateRequestSchema = z.object({
  type: z.literal("tasks.create.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  attachments: z.array(TaskUploadedFileAttachmentSchema).optional(),
});

export const TaskCreateResponseSchema = z.object({
  type: z.literal("tasks.create.response"),
  payload: z.object({
    requestId: z.string(),
    task: TaskCardSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TaskUpdateRequestSchema = z.object({
  type: z.literal("tasks.update.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["active", "completed"]).optional(),
});

export const TaskUpdateResponseSchema = z.object({
  type: z.literal("tasks.update.response"),
  payload: z.object({
    requestId: z.string(),
    task: TaskCardSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TaskDeleteRequestSchema = z.object({
  type: z.literal("tasks.delete.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
});

export const TaskDeleteResponseSchema = z.object({
  type: z.literal("tasks.delete.response"),
  payload: z.object({
    requestId: z.string(),
    taskId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TaskAttachmentDownloadTokenRequestSchema = z.object({
  type: z.literal("tasks.attachment.download_token.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  attachmentId: z.string().min(1),
});

export const TaskAttachmentDownloadTokenResponseSchema = z.object({
  type: z.literal("tasks.attachment.download_token.response"),
  payload: z.object({
    requestId: z.string(),
    taskId: z.string(),
    attachmentId: z.string(),
    token: z.string().nullable(),
    path: z.string().nullable(),
    fileName: z.string().nullable(),
    mimeType: z.string().nullable(),
    size: z.number().nullable(),
    error: z.string().nullable(),
  }),
});
