import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "npm:zod";
import { validateStudents } from "../validator.ts";

/**
 * Tool wrapper for validating student JSON input.
 * Designed for direct invocation so validation is a guaranteed first step.
 *
 * Why wrap the native validator as a “tool”:
 * - Tool outputs are explicit, structured, and can be logged/audited as a distinct pipeline stage.
 * - In more agentic versions of this system, an LLM planner could choose to call this tool before analysis.
 * - In this demo, we call it directly in `src/run_with_tool.ts` so the validation stage is always present.
 *
 * Note:
 * - We return a JSON *string* (not a JS object) to match typical tool-return conventions and keep logging simple.
 */
export const validateStudentsTool = new DynamicStructuredTool({
  // Tool name is how LangChain identifies and logs this function.
  name: "validate_students",
  // The description guides tool usage when shown to an LLM (even if not used here).
  description: "Validate a JSON array of student records and return counts + errors.",
  // Structured input schema ensures callers pass a single JSON blob.
  schema: z.object({
    // We accept unknown so the validator can report structural problems.
    data: z.unknown().describe("Raw student JSON array"),
  }),
  // Tool function returns a JSON string so it's easy to log or store.
  func: async ({ data }) => {
    // Delegate to the strict validator already used in the core pipeline.
    const result = validateStudents(data);
    // Include full error list for visibility in logs or storage.
    return JSON.stringify({
      validCount: result.valid.length,
      errorCount: result.errors.length,
      errors: result.errors,
    });
  },
});
