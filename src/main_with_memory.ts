import { load } from "@std/dotenv";
import { analyzeStudent, buildTeacherSummary } from "./analyzer.ts";
import { buildStudentEmail, buildTeacherEmail, sendEmail } from "./email.ts";
import { createLogger } from "./logger.ts";
import {
  buildFallbackStudentInsights,
  buildFallbackTeacherInsights,
  parseStudentInsights,
  parseTeacherInsights,
  renderStudentMessage,
  renderTeacherMessage,
} from "./insights.ts";
import { loadTeacherRules } from "./rules.ts";
import { HistoryStore } from "./storage.ts";
import { validateStudents } from "./validator.ts";
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
import { createAgentWithMemory } from "./agent_with_memory.ts";
import type { AppConfig, Student } from "./types.ts";

/**
 * Scheduler entry point (memory-aware, no tool-first validation).
 *
 * Compared to `src/main.ts`, this version:
 * - Loads per-student and teacher memory files from disk.
 * - Injects compact memory context into LLM prompts via `createAgentWithMemory(...)`.
 * - Updates memory after successful insight generation and writes immutable per-run archives.
 *
 * In this repo, the default `deno task start` runs `src/run_with_tool.ts`, which is also memory-aware,
 * but adds an explicit LangChain tool validation step at the start of each run.
 */
// Memory-mode config extends the base app config with memory settings.
type MemoryConfig = AppConfig & {
  // Directory that holds teacher + per-student memory JSON files.
  memoryDir: string;
  // Maximum number of history entries stored in each memory file.
  memoryHistoryLimit: number;
};

async function loadConfig(): Promise<MemoryConfig> {
  // Load environment variables and allow empty values for optional keys.
  try {
    await load({ export: true, allowEmptyValues: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  // Core LLM configuration that controls the model and endpoint.
  const openAiApiKey = requireEnv("OPENAI_API_KEY");
  const openAiModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4";
  const openAiBaseUrl = Deno.env.get("OPENAI_BASE_URL") ?? undefined;
  const openAiPriceInputPer1K = parseOptionalNumber(Deno.env.get("OPENAI_PRICE_INPUT_PER_1K"));
  const openAiPriceOutputPer1K = parseOptionalNumber(Deno.env.get("OPENAI_PRICE_OUTPUT_PER_1K"));
  // Email simulation configuration used by the local email sink.
  const emailFrom = Deno.env.get("EMAIL_FROM") ?? "Edu Assistant <noreply@local>";
  const teacherEmail = Deno.env.get("TEACHER_EMAIL") ?? "teacher@example.com";
  const emailOutDir = Deno.env.get("EMAIL_OUT_DIR") ?? undefined;
  // History and personalization configuration (SQLite + optional rules).
  const historyDbPath = Deno.env.get("HISTORY_DB_PATH") ?? "data/history.db";
  const teacherRulesPath = Deno.env.get("TEACHER_RULES_PATH") ?? undefined;
  // Data inputs and scheduling configuration for repeated runs.
  const studentsJsonPath = Deno.env.get("STUDENTS_JSON_PATH") ?? "students.json";
  const scheduleCron = Deno.env.get("SCHEDULE_CRON") ?? undefined;
  const scheduleIntervalMin = parseNumber(Deno.env.get("SCHEDULE_INTERVAL_MIN"), 30);
  const logLevel = (Deno.env.get("LOG_LEVEL") ?? "info") as AppConfig["logLevel"];
  // Memory files configuration for per-student and teacher snapshots.
  const memoryDir = Deno.env.get("MEMORY_DIR") ?? "memory";
  const memoryHistoryLimit = parseNumber(Deno.env.get("MEMORY_HISTORY_LIMIT"), 5);

  // Return a fully populated config object for the run loop.
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
  // Explicitly fail fast when required env vars are missing.
  const value = Deno.env.get(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseNumber(value: string | undefined, fallback: number): number {
  // Shared helper to parse numeric env vars with safe defaults.
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

async function loadStudents(
  path: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{ students: Student[]; totalCount: number }> {
  try {
    // Load the JSON file from disk.
    const data = await Deno.readTextFile(path);
    const parsed = JSON.parse(data) as unknown;
    // Validation returns only clean records and error details for logging.
    const { valid, errors } = validateStudents(parsed);
    const totalCount = Array.isArray(parsed) ? parsed.length : 0;

    if (errors.length > 0) {
      logger.warn("Student data validation issues", { count: errors.length });
      errors.forEach((error) => logger.warn("Validation error", { error }));
    }

    return { students: valid, totalCount };
  } catch (error) {
    logger.error("Failed to load student data", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Run a single analysis + email cycle using memory files.
 */
async function runOnce(config: MemoryConfig, store: HistoryStore) {
  const logger = createLogger(config.logLevel);
  logger.info("Starting analysis cycle (memory mode)");
  // Track run-level metadata for history reporting.
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  const { students, totalCount } = await loadStudents(config.studentsJsonPath, logger);
  logger.info("Loaded student data", { count: students.length });
  // Start the history record early so the run is traceable even on failure.
  store.startRun({
    runId,
    startedAt,
    studentCount: totalCount,
    validStudentCount: students.length,
  });

  if (students.length === 0) {
    logger.warn("No valid students available for analysis");
    store.finishRun(runId, "no_valid_students");
    return;
  }

  // Memory-aware agent receives both teacher rules and student memory.
  const agent = createAgentWithMemory(config, logger, config.teacherRules);
  // Collect analyses for the teacher summary step.
  const analyses: ReturnType<typeof analyzeStudent>[] = [];

  for (const student of students) {
    let analysis: ReturnType<typeof analyzeStudent>;
    try {
      // Create deterministic metrics used by the LLM prompts.
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
      // Load memory before LLM call so the prompt references prior context.
      const studentMemory = await loadStudentMemory(config.memoryDir, student.id, logger);
      // Call the LLM to generate structured JSON insights.
      const rawInsights = await agent.generateStudentInsights(analysis, studentMemory);
      const parsed = parseStudentInsights(rawInsights);
      const usedFallback = !parsed.ok;
      if (!parsed.ok) {
        logger.warn("Student insights JSON invalid; using fallback", {
          studentId: analysis.student.id,
          errors: parsed.errors,
        });
      }

      // Use deterministic fallback when the LLM returns invalid JSON.
      const insights = parsed.ok
        ? parsed.value
        : buildFallbackStudentInsights(analysis, config.teacherRules);
      // Render the structured insights into a readable message.
      const message = renderStudentMessage(insights);
      // Wrap the message in the student email template.
      const email = buildStudentEmail(analysis.student, message);
      // Send returns the saved email file path (or null).
      const emailPath = await sendEmail(config, email, logger);

      // Log the successful student message to history DB.
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

      // Update the student's memory file based on final insights.
      const updatedMemory = updateStudentMemory(
        studentMemory,
        analysis.student,
        insights,
        config.memoryHistoryLimit,
      );
      // Persist memory only after a successful insights flow.
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
    logger.warn("No successful analyses; skipping teacher summary");
    store.finishRun(runId, "no_successful_analyses");
    return;
  }

  try {
    const teacherSummary = buildTeacherSummary(analyses);
    // Teacher memory informs class-level suggestions.
    const teacherMemory = await loadTeacherMemory(config.memoryDir, logger);
    // Call the LLM to generate structured JSON for the teacher summary.
    const rawSummary = await agent.generateTeacherSummary(teacherSummary, teacherMemory);
    const parsed = parseTeacherInsights(rawSummary);
    const usedFallback = !parsed.ok;
    if (!parsed.ok) {
      logger.warn("Teacher summary JSON invalid; using fallback", { errors: parsed.errors });
    }

    // Use deterministic fallback when the LLM returns invalid JSON.
    const insights = parsed.ok
      ? parsed.value
      : buildFallbackTeacherInsights(teacherSummary, config.teacherRules);
    // Render the structured summary into a readable report.
    const message = renderTeacherMessage(insights);
    // Wrap the report into the teacher email template.
    const teacherEmail = buildTeacherEmail(config.teacherEmail, message);
    // Send returns the saved email file path (or null).
    const emailPath = await sendEmail(config, teacherEmail, logger);

    // Log the teacher summary to history DB for auditability.
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
    // Save teacher memory after a successful summary.
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
}

async function main() {
  const config = await loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info("Local email simulation enabled (memory mode)");

  // Preferences are loaded once and passed into the LLM prompt.
  config.teacherRules = await loadTeacherRules(config.teacherRulesPath, logger);
  // Initialize SQLite history storage for auditability.
  const store = new HistoryStore(config.historyDbPath, logger);

  // Schedule runner keeps the process alive and logs failures per cycle.
  const scheduleRun = () => {
    runOnce(config, store).catch((error) => {
      logger.error("Scheduled run failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  logger.info("Starting scheduler");
  // Always run once at startup to avoid waiting for the first interval.
  scheduleRun();

  if (config.scheduleCron) {
    // Cron schedule takes precedence if provided.
    Deno.cron("student-analysis-memory", config.scheduleCron, scheduleRun);
    logger.info("Cron schedule configured", { cron: config.scheduleCron });
  } else {
    // Interval schedule is a simple fallback when no cron is defined.
    const intervalMs = config.scheduleIntervalMin * 60 * 1000;
    setInterval(scheduleRun, intervalMs);
    logger.info("Interval schedule configured", { minutes: config.scheduleIntervalMin });
  }
}

if (import.meta.main) {
  // Prevent auto-run when imported for testing or composition.
  main().catch((error) => {
    console.error("Fatal error", error);
  });
}
