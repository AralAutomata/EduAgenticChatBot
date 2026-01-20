import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { AppConfig, StudentAnalysis, TeacherSummary, TeacherPreferences } from "./types.ts";
import type { Logger } from "./logger.ts";

/**
 * “Batch insights” LLM agent (no memory).
 *
 * This agent is used by the scheduled pipeline in `src/main.ts` to turn deterministic analysis into
 * structured JSON outputs (`StudentInsights` and `TeacherInsights`).
 *
 * Why structured JSON:
 * - It lets us validate the output deterministically (`src/insights.ts`).
 * - It keeps message rendering stable and avoids hallucinated formatting.
 *
 * Why this agent exists separately from chat:
 * - Batch mode optimizes for machine-parseable, contract-driven output.
 * - Chat mode optimizes for conversational UX and role-based boundaries.
 */
function createModel(config: AppConfig) {
  const modelConfig = {
    openAIApiKey: config.openAiApiKey,
    modelName: config.openAiModel,
    // Slightly higher temperature than chat can yield more variety in suggestions,
    // but we still rely on JSON validation and fallbacks for correctness.
    temperature: 0.8,
    configuration: config.openAiBaseUrl
      ? { baseURL: config.openAiBaseUrl }
      : undefined,
  };

  // ChatOpenAI is a LangChain wrapper; it normalizes request/response shapes for OpenAI-like APIs.
  return new ChatOpenAI(modelConfig);
}

/**
 * Build an LLM agent that turns structured analysis into personalized insights.
 */
export function createAgent(config: AppConfig, logger: Logger, preferences?: TeacherPreferences) {
  const model = createModel(config);
  // We pass preferences as JSON text for consistency and to reduce prompt ambiguity.
  const teacherRulesJson = preferences ? JSON.stringify(preferences, null, 2) : "None";

  // The student prompt asks the model to emit a *single JSON object* with fixed fields and small arrays.
  const studentPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are an educational coach writing for a student. Use a warm, encouraging, growth-mindset tone grounded in the analysis and teacher notes. Return ONLY valid JSON with these fields: positiveObservation (string), strengths (array of 1-3 strings), improvementAreas (array of 1-2 strings), strategies (array of 2-3 strings), nextStepGoal (string), encouragement (string). Avoid raw scores, sensitive labels, or mention of JSON.",
    ],
    [
      "human",
      // We embed the analysis object as pretty JSON to make the structure explicit to the model.
      "Student analysis JSON:\n{analysisJson}\n\nTeacher preferences JSON:\n{teacherRulesJson}\n\nReturn ONLY the JSON object.",
    ],
  ]);

  // The teacher prompt is similar but uses class-level summary input.
  const teacherPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are an educational coach preparing a class summary for the teacher. Use a supportive, solution-oriented tone. Return ONLY valid JSON with fields: classOverview (string), strengths (array of 1-4 strings), attentionNeeded (array of objects with name and reason), nextSteps (array of 2-4 strings). Avoid raw scores or shaming language.",
    ],
    [
      "human",
      "Teacher summary JSON:\n{summaryJson}\n\nTeacher preferences JSON:\n{teacherRulesJson}\n\nReturn ONLY the JSON object.",
    ],
  ]);

  return {
    async generateStudentInsights(analysis: StudentAnalysis): Promise<string> {
      const analysisJson = JSON.stringify(analysis, null, 2);
      // Logging uses studentId so you can correlate LLM failures with specific records.
      logger.debug("Generating student insights", { studentId: analysis.student.id });
      // `pipe(model)` builds a runnable chain: template → model.
      const chain = studentPrompt.pipe(model);
      // Chain invocation substitutes variables into the prompt and calls the model.
      const response = await chain.invoke({ analysisJson, teacherRulesJson });
      // We return raw text; downstream parsing/validation decides whether to accept it.
      return response.content.toString();
    },

    async generateTeacherSummary(summary: TeacherSummary): Promise<string> {
      const summaryJson = JSON.stringify(summary, null, 2);
      logger.debug("Generating teacher summary");
      const chain = teacherPrompt.pipe(model);
      const response = await chain.invoke({ summaryJson, teacherRulesJson });
      return response.content.toString();
    },
  };
}
