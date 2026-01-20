import { z } from "zod";

/**
 * Runtime validation schemas for shared API payloads.
 *
 * Why Zod here:
 * - TypeScript types are erased at runtime; the UI and proxy routes still need to validate user input.
 * - Putting schemas next to the shared contracts keeps “what we accept” aligned with “what we claim”.
 *
 * How these schemas are used:
 * - Next.js proxy routes validate incoming browser payloads before forwarding to Deno.
 * - The backend also does basic validation, but validating early improves error messages and avoids noisy logs.
 */
export const chatRequestSchema = z.object({
  // Optional but useful for grouping a chat session.
  sessionId: z.string().min(1).optional(),
  // Required: identifies the caller in the demo (not authentication).
  userId: z.string().min(1),
  // Role is a closed set so backends can enforce behavior.
  role: z.enum(["student", "teacher", "admin"]),
  // Must be a non-empty string to avoid accidental “blank” sends.
  message: z.string().min(1),
  // Optional in the schema because admin omits it; the backend enforces role-specific rules.
  studentId: z.string().min(1).optional(),
  // Free-form context bag for future extensions.
  context: z.record(z.unknown()).optional(),
});

export const chatResponseSchema = z.object({
  // Reply must be a non-empty string so the UI can render without special casing.
  reply: z.string().min(1),
  memoryUpdated: z.boolean(),
  runId: z.string().min(1).optional(),
  usage: z
    .object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      totalTokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
});

export const analyzeRequestSchema = z.object({
  scope: z.enum(["all", "student"]).optional(),
  studentId: z.string().min(1).optional(),
  dryRun: z.boolean().optional(),
});

export const analyzeResponseSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "failed"]),
});

export const configResponseSchema = z.object({
  openAiModel: z.string().min(1),
  scheduleCron: z.string().optional(),
  scheduleIntervalMin: z.number().positive(),
  memoryDir: z.string().min(1),
  memoryHistoryLimit: z.number().positive(),
  studentsJsonPath: z.string().min(1),
  teacherRulesPath: z.string().optional(),
  historyDbPath: z.string().min(1),
  emailOutDir: z.string().optional(),
  apiHost: z.string().min(1),
  apiPort: z.number().positive(),
  apiCorsOrigin: z.string().min(1),
});

export const studentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // Email is optional because the backend might choose to omit it in some deployments.
  email: z.string().email().optional(),
});

export const studentListResponseSchema = z.object({
  // List is allowed to be empty if the backend can’t load students (UI will fall back to manual id entry).
  students: z.array(studentProfileSchema),
});
