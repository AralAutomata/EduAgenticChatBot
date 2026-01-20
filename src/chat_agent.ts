import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { AppConfig, TeacherPreferences } from "./types.ts";
import type { Logger } from "./logger.ts";

/**
 * Role-aware chat agent used by the HTTP API server (`src/http_server.ts`).
 *
 * How this differs from the batch insight agent:
 * - Chat output is free-form text (not strict JSON), optimized for interactive UX.
 * - Prompts enforce role boundaries (student vs teacher vs admin) to reduce accidental data leakage.
 * - Token usage is extracted (best-effort) so the UI can show session totals and estimated spend.
 */
export interface ChatContext {
  role: "student" | "teacher" | "admin";
  message: string;
  memorySummary?: string;
  teacherRules?: TeacherPreferences;
  studentName?: string;
  systemSummary?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChatReply {
  content: string;
  usage?: TokenUsage;
}

function createModel(config: AppConfig) {
  const modelConfig = {
    openAIApiKey: config.openAiApiKey,
    modelName: config.openAiModel,
    // Keep chat fairly stable and helpful; a mid temperature avoids robotic outputs without getting too random.
    temperature: 0.7,
    configuration: config.openAiBaseUrl
      ? { baseURL: config.openAiBaseUrl }
      : undefined,
  };

  return new ChatOpenAI(modelConfig);
}

/**
 * Simple chat agent for the API server (non-scheduled).
 */
export function createChatAgent(config: AppConfig, logger: Logger) {
  const model = createModel(config);

  // Student prompt: direct-to-student language, and explicit instruction to avoid raw grades.
  const studentPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are an educational assistant writing directly to a student. Be supportive, specific, and concise. Always refer to the student by name (use the provided name). Do not include sign-offs, signatures, or placeholders like \"[Your Name]\". Use memory context if provided, but do not mention it explicitly. Avoid raw grades or private data.",
    ],
    [
      "human",
      // We include role/name/memory/rules as plain text so the model has the full context it needs for tone and scope.
      "Role: {role}\nStudent Name: {studentName}\nMemory Summary: {memorySummary}\nTeacher Preferences: {teacherRules}\n\nUser Message: {message}",
    ],
  ]);

  // Teacher prompt: address the teacher, not the student, and use labeled sections for scannability.
  const teacherPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are an educational assistant writing directly to a teacher about a student. Provide student-focused guidance and classroom coaching strategies, and address the teacher (not the student). Avoid second-person pronouns like \"you\" or \"your\". Always refer to the student by name (use the provided name) in third person. Do not include sign-offs, signatures, or placeholders like \"[Your Name]\". Use memory context if provided, but do not mention it explicitly. Avoid raw grades or private data. Do not discuss system configuration or run status. Format the response with these labeled sections:\n- Student Overview\n- Strengths\n- Growth Areas\n- Next Steps\n- In-class Strategy\n- Family/Guardian Note (optional)",
    ],
    [
      "human",
      "Student Name: {studentName}\nMemory Summary: {memorySummary}\nTeacher Preferences: {teacherRules}\n\nTeacher Message: {message}",
    ],
  ]);

  // Admin prompt: system-only. It should talk about model/schedule/run status, never student performance.
  const adminPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are a system operations assistant for the educational agent. Only discuss system health, configuration, scheduling, and recent run status. Do not discuss individual students or student performance. If asked about students, explain that admin access is limited to system status.",
    ],
    [
      "human",
      "System Summary: {systemSummary}\n\nUser Message: {message}",
    ],
  ]);

  return {
    async reply(context: ChatContext): Promise<ChatReply> {
      // Normalize optional strings so prompts get explicit "None"/"Unknown" instead of empty text.
      const memorySummary = context.memorySummary?.trim() || "None";
      const teacherRules = context.teacherRules
        ? JSON.stringify(context.teacherRules, null, 2)
        : "None";
      const studentName = context.studentName?.trim() || "Unknown";
      const systemSummary = context.systemSummary?.trim() || "None";

      // Select the correct prompt template for the role, then attach the model.
      const chain = (
        context.role === "admin"
          ? adminPrompt
          : context.role === "teacher"
          ? teacherPrompt
          : studentPrompt
      ).pipe(model);
      logger.debug("Generating chat reply", { role: context.role });

      // Invoke the chain with the variables expected by the chosen prompt template.
      const response = await chain.invoke({
        role: context.role,
        studentName,
        memorySummary,
        teacherRules,
        systemSummary,
        message: context.message,
      });
      return {
        content: response.content.toString(),
        // Token usage extraction is best-effort because different providers/versions shape metadata differently.
        usage: extractTokenUsage(response),
      };
    },
  };
}

function extractTokenUsage(response: unknown): TokenUsage | undefined {
  // LangChain’s response objects can vary by provider/version; we search common metadata shapes.
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  return (
    normalizeUsage(record.usage_metadata) ??
    normalizeUsage(record.response_metadata) ??
    normalizeUsage((record.response_metadata as Record<string, unknown> | undefined)?.usage) ??
    normalizeUsage((record.response_metadata as Record<string, unknown> | undefined)?.tokenUsage) ??
    normalizeUsage((record.response_metadata as Record<string, unknown> | undefined)?.usage_metadata) ??
    normalizeUsage(record.additional_kwargs) ??
    normalizeUsage((record.additional_kwargs as Record<string, unknown> | undefined)?.usage) ??
    normalizeUsage((record.additional_kwargs as Record<string, unknown> | undefined)?.usage_metadata)
  );
}

function normalizeUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  // Different APIs use different field names. We accept several common ones.
  const inputTokens =
    readNumber(record.input_tokens) ??
    readNumber(record.prompt_tokens) ??
    readNumber(record.promptTokens) ??
    readNumber(record.inputTokens);
  const outputTokens =
    readNumber(record.output_tokens) ??
    readNumber(record.completion_tokens) ??
    readNumber(record.completionTokens) ??
    readNumber(record.outputTokens);
  const totalTokens =
    readNumber(record.total_tokens) ??
    readNumber(record.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  // If partial data is present, we treat missing counts as 0 and compute totals conservatively.
  const safeInput = inputTokens ?? 0;
  const safeOutput = outputTokens ?? 0;
  return {
    inputTokens: safeInput,
    outputTokens: safeOutput,
    totalTokens: totalTokens ?? safeInput + safeOutput,
  };
}

function readNumber(value: unknown): number | undefined {
  // Guard against NaN and infinity: they would poison cost calculations and UI totals.
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
