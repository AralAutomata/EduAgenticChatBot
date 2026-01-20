import { Database } from "@db/sqlite";
import { dirname } from "@std/path";
import type { Logger } from "./logger.ts";
import type { StudentAnalysis, StudentInsights, TeacherInsights, TeacherSummary } from "./types.ts";

/**
 * SQLite-backed audit/history store.
 *
 * Why SQLite:
 * - Single-file persistence fits local demos and workshops.
 * - Simple schema supports “what happened last run?” queries and UI status panels.
 * - Storing both run metadata and per-student/teacher message results makes debugging and retrospection easy.
 *
 * What this store is (and isn’t):
 * - It is a lightweight append/update store for run history.
 * - It is not an ORM and doesn’t try to model every relationship.
 * - It is tolerant of failures: most methods catch/log errors so one DB hiccup doesn’t crash the whole pipeline.
 */
export interface RunStats {
  runId: string;
  startedAt: string;
  studentCount: number;
  validStudentCount: number;
}

export interface HistoryRunEntry {
  runId: string;
  startedAt: string;
  completedAt?: string;
  studentCount: number;
  validStudentCount: number;
  status: string;
}

/**
 * Simple SQLite-backed store for run history and generated messages.
 */
export class HistoryStore {
  #db: Database;
  #logger: Logger;

  constructor(path: string, logger: Logger) {
    this.#logger = logger;
    // Ensure parent directory exists so opening the DB file doesn’t fail on first run.
    const dir = dirname(path);
    if (dir && dir !== ".") {
      Deno.mkdirSync(dir, { recursive: true });
    }
    // Opening the DB is side-effectful (FFI), so this happens once at startup.
    this.#db = new Database(path);
    this.#init();
  }

  #init() {
    // Schema creation is idempotent: CREATE TABLE IF NOT EXISTS is safe on startup.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        student_count INTEGER NOT NULL,
        valid_student_count INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `);

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS student_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        analysis_json TEXT,
        insights_json TEXT,
        email_subject TEXT,
        email_path TEXT,
        status TEXT NOT NULL,
        error TEXT,
        used_fallback INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS teacher_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        insights_json TEXT,
        email_subject TEXT,
        email_path TEXT,
        status TEXT NOT NULL,
        error TEXT,
        used_fallback INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  startRun(stats: RunStats) {
    try {
      // Insert a “running” record immediately so we can see a run even if it crashes mid-way.
      this.#db.exec(
        `INSERT INTO runs (id, started_at, student_count, valid_student_count, status)
         VALUES (?, ?, ?, ?, ?)`,
        [
          stats.runId,
          stats.startedAt,
          stats.studentCount,
          stats.validStudentCount,
          "running",
        ],
      );
    } catch (error) {
      this.#logger.error("Failed to record run start", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  finishRun(runId: string, status: string) {
    // We record completion time at finish; this gives a simple run duration via subtraction.
    const completedAt = new Date().toISOString();
    try {
      this.#db.exec(
        `UPDATE runs SET completed_at = ?, status = ? WHERE id = ?`,
        [completedAt, status, runId],
      );
    } catch (error) {
      this.#logger.error("Failed to record run completion", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  recordStudentMessage(params: {
    runId: string;
    studentId: string;
    analysis?: StudentAnalysis;
    insights?: StudentInsights;
    emailSubject?: string;
    emailPath?: string | null;
    status: string;
    error?: string;
    usedFallback: boolean;
  }) {
    // Every student message gets its own row so partial success is preserved.
    const createdAt = new Date().toISOString();
    try {
      this.#db.exec(
        `INSERT INTO student_messages
          (id, run_id, student_id, analysis_json, insights_json, email_subject, email_path, status, error, used_fallback, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          params.runId,
          params.studentId,
          // Store JSON blobs for audit/debug. These are not queried by the demo UI, but are handy for inspection.
          params.analysis ? JSON.stringify(params.analysis) : null,
          params.insights ? JSON.stringify(params.insights) : null,
          params.emailSubject ?? null,
          params.emailPath ?? null,
          params.status,
          params.error ?? null,
          // SQLite has no boolean type, so we store 0/1.
          params.usedFallback ? 1 : 0,
          createdAt,
        ],
      );
    } catch (error) {
      this.#logger.error("Failed to record student message", {
        studentId: params.studentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  recordTeacherMessage(params: {
    runId: string;
    summary: TeacherSummary;
    insights?: TeacherInsights;
    emailSubject?: string;
    emailPath?: string | null;
    status: string;
    error?: string;
    usedFallback: boolean;
  }) {
    // Teacher messages are per-run (one row per run), capturing the class-level summary.
    const createdAt = new Date().toISOString();
    try {
      this.#db.exec(
        `INSERT INTO teacher_messages
          (id, run_id, summary_json, insights_json, email_subject, email_path, status, error, used_fallback, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          params.runId,
          JSON.stringify(params.summary),
          params.insights ? JSON.stringify(params.insights) : null,
          params.emailSubject ?? null,
          params.emailPath ?? null,
          params.status,
          params.error ?? null,
          params.usedFallback ? 1 : 0,
          createdAt,
        ],
      );
    } catch (error) {
      this.#logger.error("Failed to record teacher message", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  listRuns(limit = 25): HistoryRunEntry[] {
    // Prepared statement keeps query logic readable and avoids string concatenation hazards.
    const stmt = this.#db.prepare(
      `SELECT id, started_at, completed_at, student_count, valid_student_count, status
       FROM runs
       ORDER BY started_at DESC
       LIMIT ?`,
    );

    try {
      const rows = stmt.all<{
        id: string;
        started_at: string;
        completed_at: string | null;
        student_count: number;
        valid_student_count: number;
        status: string;
      }>(limit);

      // Convert DB column names into the API-facing shape used by the server.
      return rows.map((row) => ({
        runId: row.id,
        startedAt: row.started_at,
        completedAt: row.completed_at ?? undefined,
        studentCount: row.student_count,
        validStudentCount: row.valid_student_count,
        status: row.status,
      }));
    } catch (error) {
      this.#logger.error("Failed to list runs", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      // Always finalize prepared statements in Deno’s sqlite binding.
      stmt.finalize();
    }
  }

  getLatestStudentInsights(studentId: string): {
    insights?: StudentInsights;
    createdAt?: string;
  } | null {
    // “Latest” is defined by created_at descending. This is simple and works well for demo history.
    const stmt = this.#db.prepare(
      `SELECT insights_json, created_at
       FROM student_messages
       WHERE student_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    );

    try {
      const row = stmt.get<{
        insights_json: string | null;
        created_at: string | null;
      }>(studentId);
      if (!row) return null;

      let insights: StudentInsights | undefined;
      if (row.insights_json) {
        try {
          // Parse may fail if older rows had different formats or were corrupted; treat as non-fatal.
          insights = JSON.parse(row.insights_json) as StudentInsights;
        } catch (error) {
          this.#logger.warn("Failed to parse latest student insights", {
            studentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        insights,
        createdAt: row.created_at ?? undefined,
      };
    } catch (error) {
      this.#logger.error("Failed to fetch latest student insights", {
        studentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      stmt.finalize();
    }
  }

  close() {
    try {
      this.#db.close();
    } catch (error) {
      this.#logger.warn("Failed to close history database", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
