import { load } from "@std/dotenv";
import { analyzeStudent, buildTeacherSummary } from "./analyzer.ts";
import { createAgent } from "./agent.ts";
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
import type { AppConfig, Student } from "./types.ts";

/**
 * Scheduler entry point (no memory, no tool-first validation).
 *
 * This file represents the “baseline” pipeline:
 * - validate input
 * - deterministic analysis
 * - call LLM for structured JSON insights
 * - validate/parse insights and fall back when needed
 * - render + write outputs
 * - record history in SQLite
 *
 * In this repo, the default `deno task start` runs `src/run_with_tool.ts` instead, which includes
 * memory and a tool-first validation step. This file remains useful as a simpler reference pipeline.
 */
async function loadConfig(): Promise<AppConfig> {
  try {
    await load({ export: true, allowEmptyValues: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const openAiApiKey = requireEnv("OPENAI_API_KEY");
  const openAiModel = Deno.env.get("OPENAI_MODEL") ?? "gpt-4";
  const openAiBaseUrl = Deno.env.get("OPENAI_BASE_URL") ?? undefined;
  const openAiPriceInputPer1K = parseOptionalNumber(Deno.env.get("OPENAI_PRICE_INPUT_PER_1K"));
  const openAiPriceOutputPer1K = parseOptionalNumber(Deno.env.get("OPENAI_PRICE_OUTPUT_PER_1K"));
  const emailFrom = Deno.env.get("EMAIL_FROM") ?? "Edu Assistant <noreply@local>";
  const teacherEmail = Deno.env.get("TEACHER_EMAIL") ?? "teacher@example.com";
  const emailOutDir = Deno.env.get("EMAIL_OUT_DIR") ?? undefined;
  const historyDbPath = Deno.env.get("HISTORY_DB_PATH") ?? "data/history.db";
  const teacherRulesPath = Deno.env.get("TEACHER_RULES_PATH") ?? undefined;
  const studentsJsonPath = Deno.env.get("STUDENTS_JSON_PATH") ?? "students.json";
  const scheduleCron = Deno.env.get("SCHEDULE_CRON") ?? undefined;
  const scheduleIntervalMin = parseNumber(Deno.env.get("SCHEDULE_INTERVAL_MIN"), 30);
  const logLevel = (Deno.env.get("LOG_LEVEL") ?? "info") as AppConfig["logLevel"];

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
  };
}

function requireEnv(key: string): string {
  // Fail fast on missing required settings so we don’t start a scheduler that can never succeed.
  const value = Deno.env.get(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseNumber(value: string | undefined, fallback: number): number {
  // Numeric env parsing is defensive to avoid NaN schedules.
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
    // Read raw file → parse JSON → validate → return only valid records.
    const data = await Deno.readTextFile(path);
    const parsed = JSON.parse(data) as unknown;
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
 * Run a single analysis + email cycle.
 */
async function runOnce(config: AppConfig, store: HistoryStore) {
  const logger = createLogger(config.logLevel);
  logger.info("Starting analysis cycle");
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  const { students, totalCount } = await loadStudents(config.studentsJsonPath, logger);
  logger.info("Loaded student data", { count: students.length });
  // Record the run start as soon as we have counts so partial runs are visible.
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

  const agent = createAgent(config, logger, config.teacherRules);
  const analyses: ReturnType<typeof analyzeStudent>[] = [];

  for (const student of students) {
    let analysis: ReturnType<typeof analyzeStudent>;
    try {
      // Deterministic analysis can’t fail for valid input, but we isolate anyway to keep runs resilient.
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
      // Batch agent returns raw text; parsing/validation determines whether to accept or fall back.
      const rawInsights = await agent.generateStudentInsights(analysis);
      const parsed = parseStudentInsights(rawInsights);
      const usedFallback = !parsed.ok;
      if (!parsed.ok) {
        logger.warn("Student insights JSON invalid; using fallback", {
          studentId: analysis.student.id,
          errors: parsed.errors,
        });
      }
      const insights = parsed.ok
        ? parsed.value
        : buildFallbackStudentInsights(analysis, config.teacherRules);
      const message = renderStudentMessage(insights);
      const email = buildStudentEmail(analysis.student, message);
      const emailPath = await sendEmail(config, email, logger);
      // Persist per-student artifacts to the DB even if some students fail later.
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
    // Teacher summary aggregates the deterministic analyses, then asks the LLM to produce structured guidance.
    const teacherSummary = buildTeacherSummary(analyses);
    const rawSummary = await agent.generateTeacherSummary(teacherSummary);
    const parsed = parseTeacherInsights(rawSummary);
    const usedFallback = !parsed.ok;
    if (!parsed.ok) {
      logger.warn("Teacher summary JSON invalid; using fallback", { errors: parsed.errors });
    }
    const insights = parsed.ok
      ? parsed.value
      : buildFallbackTeacherInsights(teacherSummary, config.teacherRules);
    const message = renderTeacherMessage(insights);
    const teacherEmail = buildTeacherEmail(config.teacherEmail, message);
    const emailPath = await sendEmail(config, teacherEmail, logger);
    store.recordTeacherMessage({
      runId,
      summary: teacherSummary,
      insights,
      emailSubject: teacherEmail.subject,
      emailPath,
      status: "sent",
      usedFallback,
    });
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
  // Config is loaded once so scheduler ticks are deterministic and fast.
  const config = await loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info("Local email simulation enabled");

  // Teacher preferences are optional; if missing, the system still runs.
  config.teacherRules = await loadTeacherRules(config.teacherRulesPath, logger);
  // Open the SQLite history store once for the lifetime of the process.
  const store = new HistoryStore(config.historyDbPath, logger);

  // Wrap runOnce so we can safely schedule it repeatedly.
  const scheduleRun = () => {
    runOnce(config, store).catch((error) => {
      logger.error("Scheduled run failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  logger.info("Starting scheduler");
  // Run immediately so you don’t have to wait for the first interval/cron tick.
  scheduleRun();

  if (config.scheduleCron) {
    // Cron takes precedence when provided.
    Deno.cron("student-analysis", config.scheduleCron, scheduleRun);
    logger.info("Cron schedule configured", { cron: config.scheduleCron });
  } else {
    // Interval fallback is simple and keeps the demo easy to reason about.
    const intervalMs = config.scheduleIntervalMin * 60 * 1000;
    setInterval(scheduleRun, intervalMs);
    logger.info("Interval schedule configured", { minutes: config.scheduleIntervalMin });
  }
}

if (import.meta.main) {
  // Guard against side-effects when importing this module (tests, compositions, etc).
  main().catch((error) => {
    console.error("Fatal error", error);
  });
}
