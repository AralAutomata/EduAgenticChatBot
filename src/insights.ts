import type { StudentAnalysis, StudentInsights, TeacherInsights, TeacherSummary, TeacherPreferences } from "./types.ts";

/**
 * LLM output handling: parse, validate, render, and fall back.
 *
 * Why this exists:
 * - LLMs are probabilistic. Even when prompted to “return ONLY JSON”, responses can include extra text,
 *   malformed JSON, missing fields, or overly-long content.
 * - The rest of the system wants *reliable* structured data so it can be safely rendered and persisted.
 *
 * Pattern:
 * 1) Extract a JSON-looking object from a raw string (`extractJsonObject`).
 * 2) Parse it with `JSON.parse`.
 * 3) Validate required fields, types, and size constraints.
 * 4) If validation fails, produce deterministic fallback insights from `StudentAnalysis` / `TeacherSummary`.
 *
 * The intent is graceful degradation: the pipeline can still produce useful coaching output even when the LLM fails.
 */
type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function safeString(value: unknown, maxLen = 240): string | undefined {
  // Only accept strings; everything else becomes undefined so validation can produce a precise error.
  if (typeof value !== "string") return undefined;
  // Trim to avoid “empty but whitespace” values.
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Cap length to avoid prompt/UX bloat and to limit what gets written to logs/DB.
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeStringArray(value: unknown, min: number, max: number, label: string): ValidationResult<string[]> {
  if (!Array.isArray(value)) {
    return { ok: false, errors: [`${label} must be an array`] };
  }

  // Normalize each entry as a bounded string; null/empty entries are dropped.
  const cleaned = value
    .map((item) => safeString(item, 180))
    .filter((item): item is string => Boolean(item));

  // Minimum ensures the assistant actually provides actionable content (e.g., at least 2 strategies).
  if (cleaned.length < min) {
    return { ok: false, errors: [`${label} must include at least ${min} item(s)`] };
  }

  // Maximum keeps payloads compact and consistent for rendering and memory updates.
  return { ok: true, value: cleaned.slice(0, max) };
}

function extractJsonObject(text: string): string | null {
  // Pragmatic extraction: find the first "{" and last "}" and slice.
  // This tolerates LLMs that wrap JSON with prose or code fences.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Parse and validate student insights JSON returned by the LLM.
 */
export function parseStudentInsights(raw: string): ValidationResult<StudentInsights> {
  // Step 1: find a plausible JSON object inside the raw text.
  const jsonCandidate = extractJsonObject(raw);
  if (!jsonCandidate) {
    return { ok: false, errors: ["No JSON object found in response"] };
  }

  // Step 2: parse JSON. If parsing fails, we cannot trust any content structurally.
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return { ok: false, errors: ["Invalid JSON in response"] };
  }

  // Step 3: validate object shape before reading properties.
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, errors: ["Response JSON must be an object"] };
  }

  // Read as a record so we can validate each required field individually.
  const record = parsed as Record<string, unknown>;
  const positiveObservation = safeString(record.positiveObservation, 220);
  const nextStepGoal = safeString(record.nextStepGoal, 200);
  const encouragement = safeString(record.encouragement, 200);

  // Validate arrays with both type and min/max constraints.
  const strengthsResult = normalizeStringArray(record.strengths, 1, 3, "strengths");
  const improvementResult = normalizeStringArray(record.improvementAreas, 1, 2, "improvementAreas");
  const strategiesResult = normalizeStringArray(record.strategies, 2, 3, "strategies");

  // Collect all errors so callers see the full contract mismatch in a single run.
  const errors: string[] = [];
  if (!positiveObservation) errors.push("positiveObservation must be a non-empty string");
  if (!nextStepGoal) errors.push("nextStepGoal must be a non-empty string");
  if (!encouragement) errors.push("encouragement must be a non-empty string");
  if (!strengthsResult.ok) errors.push(...strengthsResult.errors);
  if (!improvementResult.ok) errors.push(...improvementResult.errors);
  if (!strategiesResult.ok) errors.push(...strategiesResult.errors);

  // Early return if any contract requirement is violated.
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // This is defensive: TypeScript doesn't narrow across our earlier check because of the generic result type.
  if (!strengthsResult.ok || !improvementResult.ok || !strategiesResult.ok) {
    return { ok: false, errors: ["Invalid student insights payload"] };
  }

  // Return a fully-typed payload that downstream code can safely render and store.
  return {
    ok: true,
    value: {
      positiveObservation: positiveObservation as string,
      strengths: strengthsResult.value,
      improvementAreas: improvementResult.value,
      strategies: strategiesResult.value,
      nextStepGoal: nextStepGoal as string,
      encouragement: encouragement as string,
    },
  };
}

/**
 * Parse and validate teacher summary JSON returned by the LLM.
 */
export function parseTeacherInsights(raw: string): ValidationResult<TeacherInsights> {
  const jsonCandidate = extractJsonObject(raw);
  if (!jsonCandidate) {
    return { ok: false, errors: ["No JSON object found in response"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return { ok: false, errors: ["Invalid JSON in response"] };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, errors: ["Response JSON must be an object"] };
  }

  const record = parsed as Record<string, unknown>;
  const classOverview = safeString(record.classOverview, 240);
  const strengthsResult = normalizeStringArray(record.strengths, 1, 4, "strengths");
  const nextStepsResult = normalizeStringArray(record.nextSteps, 2, 4, "nextSteps");

  // Teacher insights include a nested array of `{ name, reason }` objects; validate carefully.
  const attentionRaw = record.attentionNeeded;
  const attentionNeeded: Array<{ name: string; reason: string }> = [];
  const attentionErrors: string[] = [];
  if (!Array.isArray(attentionRaw)) {
    attentionErrors.push("attentionNeeded must be an array");
  } else {
    attentionRaw.forEach((item, index) => {
      if (typeof item !== "object" || item === null) {
        attentionErrors.push(`attentionNeeded[${index}] must be an object`);
        return;
      }
      const entry = item as Record<string, unknown>;
      const name = safeString(entry.name, 80);
      const reason = safeString(entry.reason, 160);
      if (!name || !reason) {
        attentionErrors.push(`attentionNeeded[${index}] must include name and reason`);
        return;
      }
      attentionNeeded.push({ name, reason });
    });
  }

  const errors: string[] = [];
  if (!classOverview) errors.push("classOverview must be a non-empty string");
  if (!strengthsResult.ok) errors.push(...strengthsResult.errors);
  if (!nextStepsResult.ok) errors.push(...nextStepsResult.errors);
  if (attentionErrors.length > 0) errors.push(...attentionErrors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (!strengthsResult.ok || !nextStepsResult.ok) {
    return { ok: false, errors: ["Invalid teacher insights payload"] };
  }

  return {
    ok: true,
    value: {
      classOverview: classOverview as string,
      strengths: strengthsResult.value,
      attentionNeeded,
      nextSteps: nextStepsResult.value,
    },
  };
}

/**
 * Render structured student insights into a plain-text message.
 */
export function renderStudentMessage(insights: StudentInsights): string {
  // Rendering is intentionally deterministic so the stored “email output” is consistent across runs.
  return [
    insights.positiveObservation,
    "",
    "Strengths:",
    ...insights.strengths.map((item) => `- ${item}`),
    "",
    "Focus areas:",
    ...insights.improvementAreas.map((item) => `- ${item}`),
    "",
    "Try this:",
    ...insights.strategies.map((item) => `- ${item}`),
    "",
    `Next step goal: ${insights.nextStepGoal}`,
    "",
    insights.encouragement,
  ].join("\n");
}

/**
 * Render structured teacher insights into a plain-text summary.
 */
export function renderTeacherMessage(insights: TeacherInsights): string {
  // Provide an explicit “none” row so the teacher message still reads well without special-casing in templates.
  const attentionLines = insights.attentionNeeded.length > 0
    ? insights.attentionNeeded.map((item) => `- ${item.name}: ${item.reason}`)
    : ["- No students flagged for immediate attention."];

  return [
    insights.classOverview,
    "",
    "Class strengths:",
    ...insights.strengths.map((item) => `- ${item}`),
    "",
    "Students needing attention:",
    ...attentionLines,
    "",
    "Next steps (next week):",
    ...insights.nextSteps.map((item) => `- ${item}`),
  ].join("\n");
}

/**
 * Generate a deterministic fallback student insight payload.
 */
export function buildFallbackStudentInsights(
  analysis: StudentAnalysis,
  preferences?: TeacherPreferences,
): StudentInsights {
  // Fallback logic is deliberately simple: derive actionable coaching based on deterministic signals.
  const strengths = analysis.strengths.length > 0
    ? analysis.strengths
    : ["You're making steady progress across your classes."];
  const improvementAreas = analysis.improvementAreas.length > 0
    ? analysis.improvementAreas.slice(0, 2)
    : ["Keep building consistency with assignments and review routines."];

  const strategies: string[] = [];
  // Strategy selection is “if signal, add a tactic”. This keeps fallbacks explainable and stable.
  if (analysis.metrics.assignmentCompletionRate < 85) {
    strategies.push("Use a checklist and finish assignments 24 hours before the deadline.");
  }
  if (analysis.metrics.participationScore <= 6) {
    strategies.push("Prepare one question or comment before class and share it.");
  }
  if (analysis.metrics.averageScore < 75) {
    strategies.push("Set a 20-minute daily review block and summarize notes in your own words.");
  }
  if (analysis.metrics.lowestSubjects.length > 0) {
    const subjects = analysis.metrics.lowestSubjects.map((grade) => grade.subject).join(", ");
    strategies.push(`Spend extra practice time on ${subjects} with short, focused sessions.`);
  }

  // Teacher preferences can “nudge” fallbacks toward classroom-aligned routines.
  const preferred = preferences?.preferredStrategies?.filter((item) => item.trim()) ?? [];
  preferred.forEach((item) => {
    if (strategies.length < 3) strategies.push(item);
  });

  // Ensure we always provide at least two strategies, even if none of the signals triggered.
  while (strategies.length < 2) {
    strategies.push("Ask for quick feedback from your teacher on one recent assignment.");
  }

  // Prefer a teacher-provided class goal as the next-step goal when available (keeps messaging consistent).
  const goal = preferences?.classGoals?.[0]?.trim() ||
    "Choose one focus area and practice it three times this week.";

  return {
    positiveObservation: strengths[0],
    strengths: strengths.slice(0, 3),
    improvementAreas,
    strategies: strategies.slice(0, 3),
    nextStepGoal: goal,
    encouragement: "Small steps add up—keep going, and reach out if you need support.",
  };
}

/**
 * Generate a deterministic fallback teacher insight payload.
 */
export function buildFallbackTeacherInsights(
  summary: TeacherSummary,
  preferences?: TeacherPreferences,
): TeacherInsights {
  // Teacher fallbacks emphasize actionable classroom steps over individual student details.
  const strengths = summary.topStudents.length > 0
    ? [`Top performers this cycle: ${summary.topStudents.join(", ")}.`]
    : ["Several students are maintaining steady performance."];

  // Provide a generic reason in fallback mode; the deterministic analyzer does not produce per-student “reasons”.
  const attentionNeeded = summary.attentionNeeded.map((name) => ({
    name,
    reason: "Flagged for additional check-ins based on recent trends.",
  }));

  const nextSteps: string[] = [];
  // Prefer teacher strategies when available to keep “next steps” aligned with the classroom’s routines.
  const preferred = preferences?.preferredStrategies ?? [];
  preferred.forEach((item) => {
    if (nextSteps.length < 2) nextSteps.push(item);
  });
  if (nextSteps.length < 2) {
    nextSteps.push("Plan one small-group session for students needing support.");
    nextSteps.push("Highlight one success story to reinforce growth mindset.");
  }

  return {
    classOverview: `Class average is ${summary.classAverage.toFixed(1)}. Overall trends are stable with a few students needing additional attention.`,
    strengths,
    attentionNeeded,
    nextSteps: nextSteps.slice(0, 4),
  };
}
