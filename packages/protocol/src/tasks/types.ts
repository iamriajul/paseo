import { z } from "zod";

export const TaskAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type TaskAttachment = z.infer<typeof TaskAttachmentSchema>;

export const TaskStatusSchema = z.enum(["active", "completed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskCardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  status: TaskStatusSchema,
  attachments: z.array(TaskAttachmentSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  order: z.number(),
});
export type TaskCard = z.infer<typeof TaskCardSchema>;
