import { load } from "@std/dotenv";
import { validateStudentsTool } from "./tools/validate_students_tool.ts";
import { validateStudents } from "./validator.ts";
import { analyzeStudent, buildTeacherSummary } from "./analyzer.ts";
import { createAgentWithMemory } from "./agent_with_memory.ts";
import {
  buildFallbackStudentInsights,
  buildFallbackTeacherInsights,
  parseStudentInsights,
  parseTeacherInsights,
  renderStudentMessage,
  renderTeacherMessage,
} from "./insights.ts";
import { buildStudentEmail, buildTeacherEmail, sendEmail } from "./email.ts";
import { createLogger } from "./logger.ts";
import { loadTeacherRules } from "./rules.ts";
import { HistoryStore } from "./storage.ts";
import {
  loadStudentMemory,
  loadTeacherMemory,
  saveStudentMemory,
  saveStudentMemoryArchive,
  saveTeacherMemory,
  saveTeacherMemoryArchive,
  updateStudentMemory,
  updateTeacherMemory,
} from "./memory_store.ts";
import type { AppConfig, Student } from "./types.ts";

/**
 * Scheduled analysis pipeline (tool-first + memory-aware).
 *
 * What it does:
 * - Loads config from env
 * - Loads raw student JSON
 * - Runs a LangChain “tool” validation call (for demonstrable tool-first workflows)
 * - Runs the native validator to filter valid students
 * - Computes deterministic analyses (pure logic)
 * - Calls the memory-aware LLM agent to produce structured JSON insights
 * - Validates LLM JSON; uses deterministic fallback if invalid
 * - Renders human-readable messages and writes local “email” artifacts
 * - Persists an audit trail to SQLite
 * - Updates memory files and writes immutable per-run memory archives
 *
 * Why “tool-first”:
 * - In agentic systems, tools provide a structured, auditable step before an LLM acts on data.
 * - Here we call the tool directly (not via an LLM planner) to guarantee the step is executed each run.
 */
// Tool-first entry point: always validate via the LangChain tool before analysis.
export type ToolConfig = AppConfig & {
  // Directory where memory JSON files are read/written.
  memoryDir: string;
  // Maximum number of history entries retained per memory file.
  memoryHistoryLimit: number;
};

export async function loadConfig(): Promise<ToolConfig> {
  // Load .env and merge into process environment, allowing empty optional vars.
  try {
    await load({ export: true, allowEmptyValues: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  // LLM configuration (required to generate insights).
  const openAiApiKey = requireEnv("OPENAI_API_KEY");
  const openAiModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4";
  const openAiBaseUrl = Deno.env.get("OPENAI_BASE_URL") ?? undefined;
  const openAiPriceInputPer1K = parseOptionalNumber(Deno.env.get("OPENAI_PRICE_INPUT_PER_1K"));
  const openAiPriceOutputPer1K = parseOptionalNumber(Deno.env.get("OPENAI_PRICE_OUTPUT_PER_1K"));
  // Email simulation configuration (local only).
  const emailFrom = Deno.env.get("EMAIL_FROM") ?? "Edu Assistant <noreply@local>";
  const teacherEmail = Deno.env.get("TEACHER_EMAIL") ?? "teacher@example.com";
  const emailOutDir = Deno.env.get("EMAIL_OUT_DIR") ?? undefined;
  // History + personalization inputs.
  const historyDbPath = Deno.env.get("HISTORY_DB_PATH") ?? "data/history.db";
  const teacherRulesPath = Deno.env.get("TEACHER_RULES_PATH") ?? undefined;
  // Data input and scheduling config.
  const studentsJsonPath = Deno.env.get("STUDENTS_JSON_PATH") ?? "students.json";
  const scheduleCron = Deno.env.get("SCHEDULE_CRON") ?? undefined;
  const scheduleIntervalMin = parseNumber(Deno.env.get("SCHEDULE_INTERVAL_MIN"), 30);
  const logLevel = (Deno.env.get("LOG_LEVEL") ?? "info") as AppConfig["logLevel"];
  // Memory settings for tool-first mode.
  const memoryDir = Deno.env.get("MEMORY_DIR") ?? "memory";
  const memoryHistoryLimit = parseNumber(Deno.env.get("MEMORY_HISTORY_LIMIT"), 5);

  // Return a fully-populated config so the run loop can stay pure.
  return {
    openAiApiKey,
    openAiModel,
    openAiBaseUrl,
    openAiPriceInputPer1K,
    openAiPriceOutputPer1K,
    emailFrom,
    teacherEmail,
    emailOutDir,
    historyDbPath,
    teacherRulesPath,
    scheduleCron,
    scheduleIntervalMin,
    studentsJsonPath,
    logLevel,
    memoryDir,
    memoryHistoryLimit,
  };
}

function requireEnv(key: string): string {
  // Ensure required config is present before the run starts.
  const value = Deno.env.get(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseNumber(value: string | undefined, fallback: number): number {
  // Helper to make env parsing predictable and defensive.
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

async function loadStudentsRaw(path: string): Promise<unknown> {
  // Load the raw JSON so the validator tool sees the original structure.
  const data = await Deno.readTextFile(path);
  // Returning unknown keeps validation strict and centralizes trust decisions.
  return JSON.parse(data) as unknown;
}

export async function runOnce(config: ToolConfig, store: HistoryStore): Promise<string> {
  const logger = createLogger(config.logLevel);
  logger.info("Starting analysis cycle (tool-first mode)");
  // Store a unique run id so all events can be tied together.
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  // Fetch the raw student payload for tool validation and filtering.
  const rawStudents = await loadStudentsRaw(config.studentsJsonPath);

  // Direct tool call: validate input before doing any analysis.
  const toolResult = await validateStudentsTool.invoke({ data: rawStudents });
  // Tool output is logged for auditability and troubleshooting.
  logger.info("Validation tool result", { toolResult });

  // Use the native validator output for actual filtering.
  const validation = validateStudents(rawStudents);
  const students = validation.valid;
  const totalCount = Array.isArray(rawStudents) ? rawStudents.length : 0;

  // Track run metadata in SQLite for later reporting.
  store.startRun({
    runId,
    startedAt,
    studentCount: totalCount,
    validStudentCount: students.length,
  });

  if (students.length === 0) {
    // Avoid LLM calls when there is no valid input.
    logger.warn("No valid students available for analysis");
    store.finishRun(runId, "no_valid_students");
    return runId;
  }

  // Memory-aware agent is used even in tool-first mode.
  const agent = createAgentWithMemory(config, logger, config.teacherRules);
  // Collect successful analyses to build the teacher summary at the end.
  const analyses: ReturnType<typeof analyzeStudent>[] = [];

  for (const student of students) {
    let analysis: ReturnType<typeof analyzeStudent>;
    try {
      // Generate deterministic metrics that guide the LLM output.
      analysis = analyzeStudent(student);
      analyses.push(analysis);
    } catch (error) {
      logger.error("Failed to analyze student", {
        studentId: student.id,
        error: error instanceof Error ? error.message : String(error),
      });
      store.recordStudentMessage({
        runId,
        studentId: student.id,
        status: "analysis_failed",
        error: error instanceof Error ? error.message : String(error),
        usedFallback: false,
      });
      continue;
    }

    try {
      // Memory is loaded per student so insights can reference past runs.
      const studentMemory = await loadStudentMemory(config.memoryDir, student.id, logger);
      // Call the LLM with analysis + memory to get structured JSON insights.
      const rawInsights = await agent.generateStudentInsights(analysis, studentMemory);
      const parsed = parseStudentInsights(rawInsights);
      const usedFallback = !parsed.ok;
      if (!parsed.ok) {
        logger.warn("Student insights JSON invalid; using fallback", {
          studentId: analysis.student.id,
          errors: parsed.errors,
        });
      }

      // Use deterministic fallback if JSON parsing fails.
      const insights = parsed.ok
        ? parsed.value
        : buildFallbackStudentInsights(analysis, config.teacherRules);
      // Render the structured insights into a human-readable message.
      const message = renderStudentMessage(insights);
      // Wrap the message into the email template used by the local sender.
      const email = buildStudentEmail(analysis.student, message);
      // Send returns the saved file path (or null if not saving).
      const emailPath = await sendEmail(config, email, logger);

      // Persist the outcome in the history DB, including fallback usage.
      store.recordStudentMessage({
        runId,
        studentId: analysis.student.id,
        analysis,
        insights,
        emailSubject: email.subject,
        emailPath,
        status: "sent",
        usedFallback,
      });

      // Update the student's memory file based on the final insights.
      const updatedMemory = updateStudentMemory(
        studentMemory,
        analysis.student,
        insights,
        config.memoryHistoryLimit,
      );
      // Persist updated memory only after a successful insights flow.
      await saveStudentMemory(config.memoryDir, updatedMemory, logger);
      await saveStudentMemoryArchive(
        config.memoryDir,
        {
          runId,
          studentId: analysis.student.id,
          createdAt: new Date().toISOString(),
          summary: updatedMemory.summary,
          strengths: updatedMemory.strengths,
          improvementAreas: updatedMemory.improvementAreas,
          goals: updatedMemory.goals,
        },
        logger,
      );
    } catch (error) {
      logger.error("Failed to process student", {
        studentId: analysis.student.id,
        error: error instanceof Error ? error.message : String(error),
      });
      store.recordStudentMessage({
        runId,
        studentId: analysis.student.id,
        analysis,
        status: "insights_failed",
        error: error instanceof Error ? error.message : String(error),
        usedFallback: false,
      });
    }
  }

  if (analyses.length === 0) {
    // If no analysis succeeded, skip the teacher summary entirely.
    logger.warn("No successful analyses; skipping teacher summary");
    store.finishRun(runId, "no_successful_analyses");
    return runId;
  }

  try {
    // Summaries aggregate the full batch for a teacher-level view.
    const teacherSummary = buildTeacherSummary(analyses);
    // Load class-level memory to inform the teacher summary.
    const teacherMemory = await loadTeacherMemory(config.memoryDir, logger);
    // Call the LLM with summary + memory for structured JSON output.
    const rawSummary = await agent.generateTeacherSummary(teacherSummary, teacherMemory);
    const parsed = parseTeacherInsights(rawSummary);
    const usedFallback = !parsed.ok;
    if (!parsed.ok) {
      logger.warn("Teacher summary JSON invalid; using fallback", { errors: parsed.errors });
    }

    // Fall back to deterministic teacher insights on invalid JSON.
    const insights = parsed.ok
      ? parsed.value
      : buildFallbackTeacherInsights(teacherSummary, config.teacherRules);
    // Render the teacher insights into a readable summary.
    const message = renderTeacherMessage(insights);
    // Wrap into the teacher email template and send locally.
    const teacherEmail = buildTeacherEmail(config.teacherEmail, message);
    const emailPath = await sendEmail(config, teacherEmail, logger);

    // Persist teacher-level results and artifacts to history DB.
    store.recordTeacherMessage({
      runId,
      summary: teacherSummary,
      insights,
      emailSubject: teacherEmail.subject,
      emailPath,
      status: "sent",
      usedFallback,
    });

    // Update the teacher memory file based on final summary insights.
    const updatedTeacherMemory = updateTeacherMemory(
      teacherMemory,
      insights,
      config.memoryHistoryLimit,
    );
    // Store updated teacher memory after a successful summary.
    await saveTeacherMemory(config.memoryDir, updatedTeacherMemory, logger);
    await saveTeacherMemoryArchive(
      config.memoryDir,
      {
        runId,
        createdAt: new Date().toISOString(),
        summary: insights.classOverview,
        strengths: insights.strengths,
        attentionNeeded: insights.attentionNeeded,
        nextSteps: insights.nextSteps,
      },
      logger,
    );
  } catch (error) {
    logger.error("Failed to send teacher summary", {
      error: error instanceof Error ? error.message : String(error),
    });
    store.recordTeacherMessage({
      runId,
      summary: buildTeacherSummary(analyses),
      status: "summary_failed",
      error: error instanceof Error ? error.message : String(error),
      usedFallback: false,
    });
  }

  store.finishRun(runId, "completed");
  logger.info("Analysis cycle completed");
  return runId;
}

async function main() {
  const config = await loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info("Local email simulation enabled (tool-first mode)");

  // Load teacher preferences so the LLM can align to instructional goals.
  config.teacherRules = await loadTeacherRules(config.teacherRulesPath, logger);
  // History storage is shared across all modes.
  const store = new HistoryStore(config.historyDbPath, logger);

  // Schedule wrapper keeps the run loop consistent with other entry points.
  const scheduleRun = () => {
    runOnce(config, store).catch((error) => {
      logger.error("Scheduled run failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  logger.info("Starting scheduler");
  // Run immediately once on startup.
  scheduleRun();

  if (config.scheduleCron) {
    // Cron schedule takes precedence when provided.
    Deno.cron("student-analysis-tool-first", config.scheduleCron, scheduleRun);
    logger.info("Cron schedule configured", { cron: config.scheduleCron });
  } else {
    // Fallback to fixed-interval scheduling.
    const intervalMs = config.scheduleIntervalMin * 60 * 1000;
    setInterval(scheduleRun, intervalMs);
    logger.info("Interval schedule configured", { minutes: config.scheduleIntervalMin });
  }
}

if (import.meta.main) {
  // Top-level guard so importing this file does not auto-run the scheduler.
  main().catch((error) => {
    console.error("Fatal error", error);
  });
}
