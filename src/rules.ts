import type { TeacherPreferences } from "./types.ts";
import type { Logger } from "./logger.ts";

/**
 * Teacher preference loading + sanitization.
 *
 * Why this exists:
 * - Teacher “rules” are optional customization that biases the assistant toward classroom goals.
 * - The file is treated as user-provided input; it may be missing, malformed, or partially complete.
 * - We sanitize aggressively so prompts don’t get junky data (empty strings, wrong types, etc).
 *
 * How it’s used:
 * - Loaded once at startup by the scheduler or API server.
 * - Passed into chat and insight-generation prompts (and fallback selection) to keep guidance aligned.
 */
function sanitizeStringArray(value: unknown): string[] | undefined {
  // Optional arrays are common in config. Return undefined when missing/empty so callers can omit the field.
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

function parseTone(value: unknown): TeacherPreferences["tone"] | undefined {
  // Restrict to the known set; this prevents arbitrary strings from leaking into prompts.
  if (typeof value !== "string") return undefined;
  if (value === "warm" || value === "neutral" || value === "direct") {
    return value;
  }
  return undefined;
}

/**
 * Load teacher preference rules from a JSON file.
 */
export async function loadTeacherRules(
  path: string | undefined,
  logger: Logger,
): Promise<TeacherPreferences | undefined> {
  // Treat absent config as “no preferences”, not an error.
  if (!path) return undefined;

  try {
    // Read/parse is deliberately wrapped so missing files or parse errors don’t crash the service.
    const data = await Deno.readTextFile(path);
    const parsed = JSON.parse(data) as Record<string, unknown>;

    if (typeof parsed !== "object" || parsed === null) {
      logger.warn("Teacher rules file must be a JSON object", { path });
      return undefined;
    }

    // Build the typed preferences object using sanitizers. This avoids undefined behavior later.
    const rules: TeacherPreferences = {
      classGoals: sanitizeStringArray(parsed.classGoals),
      focusAreas: sanitizeStringArray(parsed.focusAreas),
      preferredStrategies: sanitizeStringArray(parsed.preferredStrategies),
      tone: parseTone(parsed.tone),
      teacherNotes: typeof parsed.teacherNotes === "string" ? parsed.teacherNotes.trim() : undefined,
    };

    logger.info("Teacher rules loaded", { path });
    return rules;
  } catch (error) {
    // “Not found” is an expected state in demos; we log a warning and continue without preferences.
    if (error instanceof Deno.errors.NotFound) {
      logger.warn("Teacher rules file not found", { path });
      return undefined;
    }
    logger.error("Failed to load teacher rules", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
