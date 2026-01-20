import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { AppConfig, StudentAnalysis, TeacherSummary, TeacherPreferences } from "./types.ts";
import type { Logger } from "./logger.ts";
import type { StudentMemory, TeacherMemory } from "./memory_store.ts";

/**
 * “Batch insights” agent with memory injection.
 *
 * What “memory” means here:
 * - A compact summary of prior insights/goals (per student) or prior class summaries (teacher).
 * - Used as *context* for the model so suggestions remain consistent and build over time.
 *
 * Why we reduce memory before prompting:
 * - Raw memory files can grow or contain fields not relevant to the current prompt.
 * - Passing only the “decision-driving” parts (summary/strengths/goals) keeps tokens down and reduces noise.
 *
 * This agent is used by:
 * - `src/main_with_memory.ts` (memory-mode scheduler)
 * - `src/run_with_tool.ts` (tool-first scheduler)
 */
function createModel(config: AppConfig) {
  // Centralized model configuration so temperature and endpoint are consistent.
  const modelConfig = {
    openAIApiKey: config.openAiApiKey,
    modelName: config.openAiModel,
    // Slightly lower temperature keeps JSON output more reliable.
    temperature: 0.7,
    configuration: config.openAiBaseUrl
      ? { baseURL: config.openAiBaseUrl }
      : undefined,
  };

  // LangChain wrapper handles API calls and retries internally.
  return new ChatOpenAI(modelConfig);
}

function reduceStudentMemory(memory?: StudentMemory): Record<string, unknown> | "None" {
  // Only pass minimal memory fields to keep prompts short and focused.
  if (!memory || (!memory.summary && memory.strengths.length === 0 && memory.goals.length === 0)) {
    return "None";
  }
  // Summarize to reduce token usage and avoid prompt bloat.
  return {
    // `summary` is the fastest way to give the model continuity without forcing it to read a long history list.
    summary: memory.summary,
    // These lists give “stable anchors” for what to reinforce or keep working on.
    strengths: memory.strengths,
    improvementAreas: memory.improvementAreas,
    goals: memory.goals,
    lastUpdated: memory.lastUpdated,
  };
}

function reduceTeacherMemory(memory?: TeacherMemory): Record<string, unknown> | "None" {
  // Same pattern as student memory: keep concise summaries for prompt context.
  if (!memory || (!memory.summary && memory.classGoals.length === 0 && memory.focusAreas.length === 0)) {
    return "None";
  }
  // Only pass fields the teacher prompt can meaningfully use.
  return {
    summary: memory.summary,
    // These are teacher-authored and therefore trusted “long-term context” for the assistant.
    classGoals: memory.classGoals,
    focusAreas: memory.focusAreas,
    lastUpdated: memory.lastUpdated,
  };
}

/**
 * Memory-aware agent for structured JSON outputs.
 */
export function createAgentWithMemory(
  config: AppConfig,
  logger: Logger,
  preferences?: TeacherPreferences,
) {
  const model = createModel(config);
  // Preferences are injected as JSON to keep prompt structure consistent.
  const teacherRulesJson = preferences ? JSON.stringify(preferences, null, 2) : "None";

  // Prompts request JSON so we can validate and safely render responses.
  const studentPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are an educational coach writing for a student. Use a warm, encouraging, growth-mindset tone grounded in analysis and memory. Return ONLY valid JSON with fields: positiveObservation (string), strengths (array of 1-3 strings), improvementAreas (array of 1-2 strings), strategies (array of 2-3 strings), nextStepGoal (string), encouragement (string). Avoid raw scores or mention of JSON.",
    ],
    [
      "human",
      // Provide analysis, memory, and preferences as separate blocks.
      // Why separate blocks:
      // - It reduces ambiguity about what is “facts” (analysis) vs “continuity” (memory) vs “constraints” (rules).
      // - It helps models follow instructions without blending sources.
      "Student analysis JSON:\n{analysisJson}\n\nStudent memory JSON:\n{memoryJson}\n\nTeacher preferences JSON:\n{teacherRulesJson}\n\nReturn ONLY the JSON object.",
    ],
  ]);

  // Teacher prompt includes memory + preferences to align with class goals.
  const teacherPrompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are an educational coach preparing a class summary for the teacher. Use a supportive, solution-oriented tone and reference memory where relevant. Return ONLY valid JSON with fields: classOverview (string), strengths (array of 1-4 strings), attentionNeeded (array of objects with name and reason), nextSteps (array of 2-4 strings). Avoid raw scores or shaming language.",
    ],
    [
      "human",
      // Memory is included to capture longitudinal trends.
      "Teacher summary JSON:\n{summaryJson}\n\nTeacher memory JSON:\n{memoryJson}\n\nTeacher preferences JSON:\n{teacherRulesJson}\n\nReturn ONLY the JSON object.",
    ],
  ]);

  return {
    async generateStudentInsights(analysis: StudentAnalysis, memory?: StudentMemory): Promise<string> {
      const analysisJson = JSON.stringify(analysis, null, 2);
      // Memory is reduced before serialization to keep prompt small.
      const memoryJson = JSON.stringify(reduceStudentMemory(memory), null, 2);
      logger.debug("Generating student insights with memory", { studentId: analysis.student.id });
      // Pipe prompt into model so we can invoke with structured variables.
      const chain = studentPrompt.pipe(model);
      const response = await chain.invoke({ analysisJson, memoryJson, teacherRulesJson });
      // Return raw text; downstream parsing validates JSON.
      return response.content.toString();
    },

    async generateTeacherSummary(summary: TeacherSummary, memory?: TeacherMemory): Promise<string> {
      const summaryJson = JSON.stringify(summary, null, 2);
      // Memory is reduced before serialization to keep prompt small.
      const memoryJson = JSON.stringify(reduceTeacherMemory(memory), null, 2);
      logger.debug("Generating teacher summary with memory");
      // Same chain pattern for teacher summary.
      const chain = teacherPrompt.pipe(model);
      const response = await chain.invoke({ summaryJson, memoryJson, teacherRulesJson });
      // Return raw text; downstream parsing validates JSON.
      return response.content.toString();
    },
  };
}
