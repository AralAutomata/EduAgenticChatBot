import { load } from "@std/dotenv";
import { createChatAgent } from "./chat_agent.ts";
import { createLogger } from "./logger.ts";
import { loadTeacherRules } from "./rules.ts";
import { HistoryStore } from "./storage.ts";
import { loadStudentMemory, loadTeacherMemory } from "./memory_store.ts";
import { loadConfig, runOnce, type ToolConfig } from "./run_with_tool.ts";
import { validateStudents } from "./validator.ts";
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  ApiError,
  ChatRequest,
  ChatResponse,
  HistoryResponse,
  ApiConfigResponse,
  StudentListResponse,
  StudentProfile,
  StudentSummaryResponse,
} from "../packages/shared-types/src/contracts.ts";
import type { Logger } from "./logger.ts";
import type { StudentMemory, TeacherMemory } from "./memory_store.ts";

/**
 * Deno HTTP API server for the agent.
 *
 * Responsibilities:
 * - Provide a stable HTTP boundary for the UI (and for operational tooling).
 * - Enforce role rules for chat requests (student vs teacher vs admin).
 * - Proxy-trigger the analysis pipeline (`runOnce`) without blocking the chat UI.
 * - Serve “safe” configuration data to the UI (no secrets).
 * - Provide a student list for UI selection (id + name + email only).
 * - Provide history/status information from SQLite.
 *
 * Important design choice:
 * - The Next.js UI talks to this server through API proxy routes, so the browser never needs OpenAI keys.
 */
interface ServerConfig extends ToolConfig {
  apiHost: string;
  apiPort: number;
  apiCorsOrigin: string;
}

async function loadServerConfig(): Promise<ServerConfig> {
  try {
    await load({ export: true, allowEmptyValues: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const baseConfig = await loadConfig();
  // The server has its own env vars (host/port/cors) layered on top of the pipeline config.
  const apiHost = Deno.env.get("API_HOST") ?? "0.0.0.0";
  const apiPort = parseNumber(Deno.env.get("API_PORT"), 8000);
  const apiCorsOrigin = Deno.env.get("API_CORS_ORIGIN") ?? "*";

  return {
    ...baseConfig,
    apiHost,
    apiPort,
    apiCorsOrigin,
  };
}

function parseNumber(value: string | undefined, fallback: number): number {
  // Defensive parsing: invalid env values should not crash the server.
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit) {
  // Pretty-print JSON responses so they’re human-friendly during demos and curl usage.
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
  });
}

function resolveCorsOrigin(
  requestOrigin: string | null,
  allowed: string,
): string | null {
  // CORS logic is intentionally simple:
  // - "*" allows all origins (best for local demos)
  // - otherwise use a comma-separated allowlist
  if (allowed === "*") return "*";
  if (!requestOrigin) return null;
  const allowList = allowed.split(",").map((value) => value.trim()).filter(Boolean);
  return allowList.includes(requestOrigin) ? requestOrigin : null;
}

function withCors(response: Response, origin: string | null): Response {
  // CORS headers are applied as a wrapper, keeping handler logic focused on business behavior.
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    // Prefer request.json() so content-type parsing is handled by the runtime.
    return await request.json();
  } catch (error) {
    // Normalize all parse failures into a single error message for the API layer.
    throw new Error("Invalid JSON body");
  }
}

function isChatRequest(value: unknown): value is ChatRequest {
  // Minimal shape validation: for stricter validation, the UI uses Zod and the server enforces role rules.
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const role = record.role;
  const isRole = role === "student" || role === "teacher" || role === "admin";
  return typeof record.userId === "string"
    && isRole
    && typeof record.message === "string";
}

function isAnalyzeRequest(value: unknown): value is AnalyzeRequest {
  // Analyze requests are intentionally small; we only allow known scope values and basic types.
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.scope && record.scope !== "all" && record.scope !== "student") return false;
  if (record.studentId && typeof record.studentId !== "string") return false;
  if (record.dryRun && typeof record.dryRun !== "boolean") return false;
  return true;
}

function buildStudentMemorySummary(memory: StudentMemory): string {
  // Chat prompts don’t need full memory JSON; we compress into a single “summary line” for token efficiency.
  const parts = [
    memory.summary,
    memory.strengths.length ? `Strengths: ${memory.strengths.join(", ")}` : "",
    memory.improvementAreas.length
      ? `Focus: ${memory.improvementAreas.join(", ")}`
      : "",
    memory.goals.length ? `Goals: ${memory.goals.join(", ")}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

function buildTeacherMemorySummary(memory: TeacherMemory): string {
  // Same approach as student summary: compact context only.
  const parts = [
    memory.summary,
    memory.focusAreas.length ? `Focus areas: ${memory.focusAreas.join(", ")}` : "",
    memory.classGoals.length ? `Class goals: ${memory.classGoals.join(", ")}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

function computeUsageCost(
  usage: { inputTokens: number; outputTokens: number } | undefined,
  config: ServerConfig,
): number | undefined {
  if (!usage) return undefined;
  const inputRate = config.openAiPriceInputPer1K;
  const outputRate = config.openAiPriceOutputPer1K;
  if (typeof inputRate !== "number" || typeof outputRate !== "number") {
    return undefined;
  }
  // A tiny helper that translates token usage into a rough USD estimate for demo visibility.
  const cost =
    (usage.inputTokens / 1000) * inputRate +
    (usage.outputTokens / 1000) * outputRate;
  return Number(cost.toFixed(6));
}

async function loadStudentsIndex(
  studentsJsonPath: string,
  logger: Logger,
): Promise<{ list: StudentProfile[]; map: Map<string, StudentProfile> }> {
  try {
    // This reads the same file used by batch analysis; we validate and then project to a safe “UI list” shape.
    const raw = await Deno.readTextFile(studentsJsonPath);
    const parsed = JSON.parse(raw) as unknown;
    const validation = validateStudents(parsed);
    const list = validation.valid.map((student) => ({
      id: student.id,
      name: student.name,
      email: student.email,
    }));
    if (validation.errors.length > 0) {
      // Warnings instead of errors because we can still serve the valid subset.
      logger.warn("Student list validation warnings", {
        count: validation.errors.length,
      });
    }
    const map = new Map(list.map((student) => [student.id, student]));
    return { list, map };
  } catch (error) {
    logger.warn("Failed to load student list for chat personalization", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { list: [], map: new Map() };
  }
}

function buildSystemSummary(config: ServerConfig, store: HistoryStore): string {
  // Admin chat uses this to answer “what’s running and how is it doing?” without exposing student data.
  const schedule = config.scheduleCron
    ? `Cron: ${config.scheduleCron}`
    : `Interval: ${config.scheduleIntervalMin} min`;
  const recentRuns = store.listRuns(5);
  const latest = recentRuns[0];
  const latestSummary = latest
    ? `Last run ${latest.status} at ${latest.startedAt} (${latest.validStudentCount}/${latest.studentCount} valid).`
    : "No runs recorded yet.";
  return [
    `Model: ${config.openAiModel}`,
    `Schedule: ${schedule}`,
    `History DB: ${config.historyDbPath}`,
    latestSummary,
  ].join(" | ");
}

async function handleChat(
  request: Request,
  config: ServerConfig,
  logger: Logger,
  agent: ReturnType<typeof createChatAgent>,
  studentsIndex: { list: StudentProfile[]; map: Map<string, StudentProfile> },
  store: HistoryStore,
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await parseJson(request);
  } catch (error) {
    return jsonResponse<ApiError>({ error: "Invalid JSON payload" }, 400);
  }

  if (!isChatRequest(payload)) {
    return jsonResponse<ApiError>({ error: "Invalid chat request" }, 400);
  }

  const { role, message, studentId, userId } = payload;

  // Enforce role boundaries early, before any memory or student lookups happen.
  if (role === "admin" && studentId) {
    return jsonResponse<ApiError>(
      { error: "Admin role cannot request student-specific data" },
      400,
    );
  }

  try {
    let memorySummary: string | undefined;
    let studentName: string | undefined;
    let systemSummary: string | undefined;
    let teacherRules = config.teacherRules;

    if (role === "admin") {
      systemSummary = buildSystemSummary(config, store);
      teacherRules = undefined;
    } else if (role === "teacher") {
      if (!studentId) {
        return jsonResponse<ApiError>(
          { error: "Teacher role requires studentId for student-specific guidance" },
          400,
        );
      }
      const profile = studentsIndex.map.get(studentId);
      if (!profile) {
        return jsonResponse<ApiError>(
          { error: "Unknown studentId for teacher request" },
          400,
        );
      }
      // Teacher mode uses student memory (not teacher memory) because the question is student-focused.
      const studentMemory = await loadStudentMemory(config.memoryDir, studentId, logger);
      memorySummary = buildStudentMemorySummary(studentMemory);
      studentName = profile.name;
    } else {
      // Student role uses either an explicit studentId or (fallback) the userId as the key.
      // This lets a simplified UI send userId-only if it maps 1:1 with student IDs.
      const id = studentId ?? userId;
      const profile = studentsIndex.map.get(id);
      if (!profile) {
        return jsonResponse<ApiError>(
          { error: "Unknown studentId for student request" },
          400,
        );
      }
      const studentMemory = await loadStudentMemory(config.memoryDir, id, logger);
      memorySummary = buildStudentMemorySummary(studentMemory);
      studentName = profile.name;
    }

    // Delegate prompt selection and generation to `src/chat_agent.ts`.
    const { content, usage } = await agent.reply({
      role,
      message,
      memorySummary,
      teacherRules,
      studentName,
      systemSummary,
    });

    // API response is a stable JSON shape shared with the UI (contracts live in packages/shared-types).
    const response: ChatResponse = {
      reply: content,
      memoryUpdated: false,
    };
    const costUsd = computeUsageCost(usage, config);
    if (usage) {
      response.usage = {
        ...usage,
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    }
    return jsonResponse(response);
  } catch (error) {
    logger.error("Chat request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse<ApiError>(
      { error: "Chat request failed" },
      500,
    );
  }
}

async function handleAnalyze(
  request: Request,
  config: ServerConfig,
  logger: Logger,
  store: HistoryStore,
  state: { running: boolean; lastRunId?: string },
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await parseJson(request);
  } catch (error) {
    return jsonResponse<ApiError>({ error: "Invalid JSON payload" }, 400);
  }

  if (!isAnalyzeRequest(payload)) {
    return jsonResponse<ApiError>({ error: "Invalid analysis request" }, 400);
  }

  const { scope } = payload;
  if (scope && scope !== "all") {
    return jsonResponse<ApiError>(
      { error: "Student-level analysis is not supported yet" },
      400,
    );
  }

  // Simple in-process concurrency guard to prevent overlapping runs from stepping on shared artifacts.
  if (state.running) {
    return jsonResponse<AnalyzeResponse>(
      { runId: state.lastRunId ?? "unknown", status: "running" },
      409,
    );
  }

  state.running = true;
  try {
    // `runOnce` is the full pipeline from `src/run_with_tool.ts`.
    const runId = await runOnce(config, store);
    state.lastRunId = runId;
    return jsonResponse<AnalyzeResponse>({ runId, status: "completed" });
  } catch (error) {
    logger.error("Analysis run failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse<AnalyzeResponse>(
      { runId: state.lastRunId ?? "unknown", status: "failed" },
      500,
    );
  } finally {
    state.running = false;
  }
}

async function handleHistory(store: HistoryStore, limit: number): Promise<Response> {
  // Return only the fields used by the UI; raw message blobs remain in the DB for debugging.
  const runs = store.listRuns(limit).map((run) => ({
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    studentCount: run.studentCount,
    validStudentCount: run.validStudentCount,
  }));

  return jsonResponse<HistoryResponse>({ runs });
}

function buildConfigResponse(config: ServerConfig): ApiConfigResponse {
  // This is “safe config”: it intentionally omits secrets like OPENAI_API_KEY.
  return {
    openAiModel: config.openAiModel,
    scheduleCron: config.scheduleCron,
    scheduleIntervalMin: config.scheduleIntervalMin,
    memoryDir: config.memoryDir,
    memoryHistoryLimit: config.memoryHistoryLimit,
    studentsJsonPath: config.studentsJsonPath,
    teacherRulesPath: config.teacherRulesPath,
    historyDbPath: config.historyDbPath,
    emailOutDir: config.emailOutDir,
    apiHost: config.apiHost,
    apiPort: config.apiPort,
    apiCorsOrigin: config.apiCorsOrigin,
  };
}

async function handleStudentSummary(
  studentId: string,
  config: ServerConfig,
  logger: Logger,
  store: HistoryStore,
): Promise<Response> {
  // This endpoint is designed for UI/debugging; it returns current memory and the latest stored insights.
  const memory = await loadStudentMemory(config.memoryDir, studentId, logger);
  const latest = store.getLatestStudentInsights(studentId);

  const payload: StudentSummaryResponse = {
    studentId,
    latestInsights: latest?.insights,
    memory,
    lastRunAt: latest?.createdAt,
  };

  return jsonResponse(payload);
}

async function main() {
  const config = await loadServerConfig();
  const logger = createLogger(config.logLevel);
  // Teacher rules are optional, but loading them once avoids repeated disk reads on each request.
  config.teacherRules = await loadTeacherRules(config.teacherRulesPath, logger);

  const chatAgent = createChatAgent(config, logger);
  // Build a student index once so chat requests can quickly resolve studentId → name.
  const studentsIndex = await loadStudentsIndex(config.studentsJsonPath, logger);
  const store = new HistoryStore(config.historyDbPath, logger);
  // `state` is kept in-memory because this demo server runs as a single process.
  const state = { running: false as boolean, lastRunId: undefined as string | undefined };

  logger.info("Starting API server", {
    host: config.apiHost,
    port: config.apiPort,
  });

  Deno.serve({ hostname: config.apiHost, port: config.apiPort }, async (request) => {
    const url = new URL(request.url);
    const origin = resolveCorsOrigin(request.headers.get("origin"), config.apiCorsOrigin);

    // Handle preflight quickly to keep browser proxying simple.
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), origin);
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return withCors(
          jsonResponse({ status: "ok", time: new Date().toISOString() }),
          origin,
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/chat") {
        const response = await handleChat(
          request,
          config,
          logger,
          chatAgent,
          studentsIndex,
          store,
        );
        return withCors(response, origin);
      }

      if (request.method === "POST" && url.pathname === "/v1/analyze") {
        const response = await handleAnalyze(request, config, logger, store, state);
        return withCors(response, origin);
      }

      if (request.method === "GET" && url.pathname === "/v1/history") {
        const limit = parseNumber(url.searchParams.get("limit") ?? undefined, 25);
        const response = await handleHistory(store, limit);
        return withCors(response, origin);
      }

      if (request.method === "GET" && url.pathname === "/v1/config") {
        const response = jsonResponse<ApiConfigResponse>(buildConfigResponse(config));
        return withCors(response, origin);
      }

      if (request.method === "GET" && url.pathname === "/v1/students") {
        const response = jsonResponse<StudentListResponse>({
          students: studentsIndex.list,
        });
        return withCors(response, origin);
      }

      if (request.method === "GET" && url.pathname.startsWith("/v1/students/")) {
        const studentId = decodeURIComponent(url.pathname.replace("/v1/students/", ""));
        if (!studentId) {
          return withCors(
            jsonResponse<ApiError>({ error: "Student id required" }, 400),
            origin,
          );
        }
        const response = await handleStudentSummary(studentId, config, logger, store);
        return withCors(response, origin);
      }

      return withCors(
        jsonResponse<ApiError>({ error: "Not found" }, 404),
        origin,
      );
    } catch (error) {
      logger.error("Unhandled API error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return withCors(
        jsonResponse<ApiError>({ error: "Internal server error" }, 500),
        origin,
      );
    }
  });
}

if (import.meta.main) {
  // Ensure this module doesn't auto-run when imported from tests or scripts.
  main().catch((error) => {
    console.error("Fatal server error", error);
  });
}
