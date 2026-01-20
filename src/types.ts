/**
 * Core domain types for the Deno agent.
 *
 * Why this file exists:
 * - The project intentionally separates "pure" logic (analysis/validation) from I/O (HTTP, DB, filesystem).
 * - Having a central type registry makes it harder for modules to silently drift in expectations (especially around
 *   what the LLM should return and what the UI/API are allowed to expose).
 *
 * How it’s used:
 * - `Student` + `Grade` describe validated input data (from `students.json`).
 * - `StudentAnalysis` + `TeacherSummary` are deterministic computations produced by `src/analyzer.ts`.
 * - `StudentInsights` + `TeacherInsights` are the *structured* outputs we request from the LLM, then validate in
 *   `src/insights.ts` before rendering to messages/emails.
 * - `AppConfig` collects runtime configuration; it is loaded from env vars by the various entry points.
 */
export type PerformanceTrend = "improving" | "stable" | "declining";

export interface Grade {
  // The class subject label is used for “weakest/strongest subject” reporting and human-readable messaging.
  subject: string;
  // Score is treated as a bounded numeric signal; downstream logic avoids exposing raw scores to end-users.
  score: number; // 0-100
}

export interface Student {
  // Stable identifier used across: memory files, chat personalization, and run history.
  id: string;
  // Display name used in end-user messaging. The UI uses this to label the dropdown.
  name: string;
  // Used for local "email" output and safe student list responses (UI selection only).
  email: string;
  // List of grades (subject + score) used to compute averages and identify extremes.
  grades: Grade[];
  // Participation is treated as a coarse behavioral engagement proxy, not a “grade”.
  participationScore: number; // 1-10
  // Completion rate is treated as a consistency proxy and used as a risk signal.
  assignmentCompletionRate: number; // 0-100
  // Free-form notes are input context for the LLM; they are not used for deterministic scoring.
  teacherNotes: string;
  // A simple qualitative trend label. The validator ensures this is in a closed set.
  performanceTrend: PerformanceTrend;
  // Used primarily for recency context; validated as a parseable date string.
  lastAssessmentDate: string; // ISO date string
}

export interface StudentMetrics {
  // Average of grade scores, rounded for readability and stable outputs.
  averageScore: number;
  // Top N subjects by score (used for strengths and messaging).
  highestSubjects: Grade[];
  // Bottom N subjects by score (used to suggest focus areas).
  lowestSubjects: Grade[];
  // Mirrors input to keep the analysis bundle self-contained for the LLM prompt.
  participationScore: number;
  // Mirrors input to keep the analysis bundle self-contained for the LLM prompt.
  assignmentCompletionRate: number;
  // Boolean shortcut used by teacher summaries and attention lists.
  needsAttention: boolean;
}

// Coarse bucketed risk levels used for teacher attention triage.
export type RiskLevel = "low" | "medium" | "high";

export interface StudentAnalysis {
  // Original validated student record.
  student: Student;
  // Deterministic metrics derived from the record.
  metrics: StudentMetrics;
  // Deterministic “strength” strings; can be used as fallback or as prompt context.
  strengths: string[];
  // Deterministic “improvement” strings; can be used as fallback or as prompt context.
  improvementAreas: string[];
  // Coarse risk label derived from thresholds in `src/analyzer.ts`.
  riskLevel: RiskLevel;
}

export interface TeacherSummary {
  // Average of student averages: a quick “class-level” trend indicator.
  classAverage: number;
  // Names of top students (for summary context; not used for grading).
  topStudents: string[];
  // Names of students flagged for attention (needsAttention or high risk).
  attentionNeeded: string[];
  // Compact notes for the teacher: e.g., how many are declining.
  notes: string[];
}

export interface TeacherPreferences {
  // Optional: stable class-level goals to anchor coaching suggestions.
  classGoals?: string[];
  // Optional: topics the teacher wants emphasized.
  focusAreas?: string[];
  // Optional: preferred intervention strategies to bias fallback and LLM output.
  preferredStrategies?: string[];
  // Optional: tone preference that can be injected into prompts or used by the UI later.
  tone?: "warm" | "neutral" | "direct";
  // Optional: free-form constraint notes (e.g., “keep feedback encouraging”).
  teacherNotes?: string;
}

export interface StudentInsights {
  // A single positive, concrete observation (the system tries to keep this short).
  positiveObservation: string;
  // 1–3 specific strengths. These are validated and then rendered as bullet points.
  strengths: string[];
  // 1–2 concrete areas to work on (kept short to avoid overwhelming students).
  improvementAreas: string[];
  // 2–3 actionable strategies; these are the “do this next” items.
  strategies: string[];
  // A single short goal statement; also used to update memory.
  nextStepGoal: string;
  // A closing encouragement line to keep tone supportive.
  encouragement: string;
}

export interface TeacherInsights {
  // High-level class overview (summary sentence/paragraph).
  classOverview: string;
  // 1–4 class strengths for the teacher.
  strengths: string[];
  // Names + reasons so the teacher knows who to check in with and why.
  attentionNeeded: Array<{ name: string; reason: string }>;
  // 2–4 next steps focused on classroom actions.
  nextSteps: string[];
}

export interface AppConfig {
  // Required secret used by the LangChain OpenAI client (never exposed to UI).
  openAiApiKey: string;
  // Model name passed through to ChatOpenAI.
  openAiModel: string;
  // Optional override for OpenAI-compatible APIs (self-hosted, proxies, etc).
  openAiBaseUrl?: string;
  // Optional pricing numbers used for UI cost estimation.
  openAiPriceInputPer1K?: number;
  // Optional pricing numbers used for UI cost estimation.
  openAiPriceOutputPer1K?: number;
  // “From” header used when writing local email artifacts.
  emailFrom: string;
  // Recipient used for teacher summary email artifacts.
  teacherEmail: string;
  // If set, emails are written to disk; otherwise they are only logged.
  emailOutDir?: string;
  // SQLite file path for the audit/history database.
  historyDbPath: string;
  // Optional path to a teacher preferences JSON file.
  teacherRulesPath?: string;
  // Loaded/parsed teacher preferences object (populated at runtime).
  teacherRules?: TeacherPreferences;
  // Optional cron schedule (takes precedence if set).
  scheduleCron?: string;
  // Interval schedule fallback when cron is not set.
  scheduleIntervalMin: number;
  // Student data file path (JSON).
  studentsJsonPath: string;
  // Controls how much operational output gets written to console.
  logLevel: LogLevel;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
