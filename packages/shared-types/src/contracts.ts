/**
 * Shared API contracts for the UI ↔ Deno agent boundary.
 *
 * Why this package exists:
 * - The UI (Next.js) and backend (Deno) are separate runtimes and could drift in request/response shapes.
 * - Centralizing the shapes makes changes explicit and encourages compile-time alignment.
 *
 * What “contract” means here:
 * - These are TypeScript interfaces used for type-checking at build time.
 * - Runtime validation is handled separately via Zod schemas in `schemas.ts` (for payloads that need it).
 */
export type UserRole = "student" | "teacher" | "admin";

export interface ChatRequest {
  // Optional: allows the UI to group a series of messages into a single conversation.
  sessionId?: string;
  // Required: caller identity from the UI’s perspective (not authentication in this demo).
  userId: string;
  // Drives server-side role rules (what data can be accessed and how the model should respond).
  role: UserRole;
  // The actual user message (plain text).
  message: string;
  // Required for teacher/student roles in practice; admin must omit.
  studentId?: string;
  // Optional extra context to attach to the request (course name, etc).
  context?: Record<string, unknown>;
}

export interface ChatResponse {
  // The assistant’s reply text (rendered directly in the UI).
  reply: string;
  // Reserved for future use (this demo chat path does not persist memory updates).
  memoryUpdated: boolean;
  // Optional: if chat triggers analysis runs later, this could link to a history record.
  runId?: string;
  // Optional usage/cost metadata if the model/provider returns it.
  usage?: TokenUsage;
}

export interface AnalyzeRequest {
  // Scope is currently “all” only; included so the contract can evolve without renaming endpoints.
  scope?: "all" | "student";
  // Placeholder for future student-specific runs.
  studentId?: string;
  // Placeholder for future “compute but don’t persist” behavior.
  dryRun?: boolean;
}

export interface AnalyzeResponse {
  runId: string;
  status: "queued" | "running" | "completed" | "failed";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  // Only set when pricing env vars are configured; intended as a rough estimate.
  costUsd?: number;
}

export interface StudentSummaryResponse {
  studentId: string;
  // Stored “latest” insights blob (as JSON). Shape is not enforced here to keep API flexible.
  latestInsights?: Record<string, unknown>;
  // Current memory object loaded from disk (shape depends on backend memory schema).
  memory?: Record<string, unknown>;
  lastRunAt?: string;
}

export interface StudentProfile {
  // Used as the stable identifier across chat, memory files, and history.
  id: string;
  // Display name used for UI selection and chat personalization.
  name: string;
  // Included for convenience in demos; may be omitted depending on backend configuration.
  email?: string;
}

export interface StudentListResponse {
  students: StudentProfile[];
}

export interface HistoryRun {
  runId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  studentCount: number;
  validStudentCount: number;
}

export interface HistoryResponse {
  runs: HistoryRun[];
}

export interface ApiConfigResponse {
  // Safe model name (no secrets).
  openAiModel: string;
  scheduleCron?: string;
  scheduleIntervalMin: number;
  // Exposes memory settings so the UI can show what the backend is doing.
  memoryDir: string;
  memoryHistoryLimit: number;
  studentsJsonPath: string;
  teacherRulesPath?: string;
  historyDbPath: string;
  emailOutDir?: string;
  apiHost: string;
  apiPort: number;
  apiCorsOrigin: string;
}

export interface ApiError {
  // Human-readable, UI-displayable error summary.
  error: string;
  // Optional detail (stackless) for debugging in the UI.
  detail?: string;
}
