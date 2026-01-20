import type { Grade, PerformanceTrend, Student } from "./types.ts";

/**
 * Boundary validator for student input data.
 *
 * Why validation is strict here:
 * - Student records are the root input to both the deterministic analysis and the LLM prompts.
 * - If we allow malformed shapes downstream, “random” runtime errors become possible in many places.
 * - Filtering invalid records (instead of throwing) supports partial success: one bad row shouldn’t stop the class run.
 *
 * How this module is used:
 * - `validateStudent(...)` validates a single record and either returns a fully-typed `Student` or a list of errors.
 * - `validateStudents(...)` applies that per-record validation across an array and collects `valid` + `errors`.
 */
type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

// Deliberately simple pattern: “good enough” for demo data quality checks without heavy dependencies.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  // We treat arrays as invalid records because our schema expects key/value objects.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  // Trimming avoids “visually empty” strings from slipping through.
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  // Explicit finite checks avoid NaN/Infinity creeping into averages and comparisons.
  return typeof value === "number" && Number.isFinite(value);
}

function inRange(value: unknown, min: number, max: number): value is number {
  // Range checks are used for the most important numeric signals.
  return isFiniteNumber(value) && value >= min && value <= max;
}

function parseTrend(value: unknown): PerformanceTrend | undefined {
  // Closed enum avoids arbitrary strings, enabling deterministic branching later.
  if (typeof value !== "string") return undefined;
  if (value === "improving" || value === "stable" || value === "declining") {
    return value;
  }
  return undefined;
}

function isValidDate(value: unknown): value is string {
  // We only require that Date.parse can interpret it; storage stays as strings for JSON friendliness.
  if (!isNonEmptyString(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function validateGrade(value: unknown, index: number): ValidationResult<Grade> {
  // Validate each grade entry independently so we can emit targeted errors like grades[2].score.
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: [`grades[${index}] must be an object`] };
  }

  // Read raw fields first; we only “trust” them once validated.
  const subject = value.subject;
  const score = value.score;
  // Normalize values used in returned `Grade` so downstream code can assume trimmed strings.
  const subjectValue = isNonEmptyString(subject) ? subject.trim() : "";
  const scoreValue = isFiniteNumber(score) ? score : 0;

  if (!isNonEmptyString(subject)) {
    errors.push(`grades[${index}].subject must be a non-empty string`);
  }
  if (!inRange(score, 0, 100)) {
    errors.push(`grades[${index}].score must be a number between 0 and 100`);
  }

  // If any constraints fail, return the full list so the user can fix multiple issues at once.
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      subject: subjectValue,
      score: scoreValue,
    },
  };
}

/**
 * Validate raw student data and return a typed Student or detailed errors.
 */
export function validateStudent(value: unknown, index: number): ValidationResult<Student> {
  // `index` is included so the caller can generate stable, grep-friendly error prefixes.
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: [`students[${index}] must be an object`] };
  }

  // Capture raw fields. Validation is applied below, then we build a cleaned `Student`.
  const id = value.id;
  const name = value.name;
  const email = value.email;
  const grades = value.grades;
  const participationScore = value.participationScore;
  const assignmentCompletionRate = value.assignmentCompletionRate;
  const teacherNotes = value.teacherNotes;
  const performanceTrend = parseTrend(value.performanceTrend);
  const lastAssessmentDate = value.lastAssessmentDate;

  // Normalize “safe” values. We still record errors if their raw forms are invalid.
  const idValue = isNonEmptyString(id) ? id.trim() : "";
  const nameValue = isNonEmptyString(name) ? name.trim() : "";
  const emailValue = isNonEmptyString(email) ? email.trim() : "";
  const participationValue = isFiniteNumber(participationScore) ? participationScore : 0;
  const completionValue = isFiniteNumber(assignmentCompletionRate) ? assignmentCompletionRate : 0;
  const notesValue = typeof teacherNotes === "string" ? teacherNotes : "";
  // `trendValue` is only meaningful if `performanceTrend` is defined.
  const trendValue = performanceTrend as PerformanceTrend;
  const lastAssessmentValue = isValidDate(lastAssessmentDate) ? lastAssessmentDate : "";

  // Validate required identity fields (they’re used as keys across the system).
  if (!isNonEmptyString(id)) {
    errors.push("id must be a non-empty string");
  }
  if (!isNonEmptyString(name)) {
    errors.push("name must be a non-empty string");
  }
  if (!isNonEmptyString(email) || !EMAIL_PATTERN.test(email)) {
    errors.push("email must be a valid address");
  }

  // Grades must be a non-empty array because the analyzer expects at least one score for an average.
  const validatedGrades: Grade[] = [];
  if (!Array.isArray(grades) || grades.length === 0) {
    errors.push("grades must be a non-empty array");
  } else {
    grades.forEach((grade, gradeIndex) => {
      const result = validateGrade(grade, gradeIndex);
      if (result.ok) {
        validatedGrades.push(result.value);
      } else {
        // Keep collecting errors to maximize feedback in one run.
        errors.push(...result.errors);
      }
    });
  }

  // Numeric constraints: these are the key “risk signal” inputs.
  if (!inRange(participationScore, 1, 10)) {
    errors.push("participationScore must be a number between 1 and 10");
  }
  if (!inRange(assignmentCompletionRate, 0, 100)) {
    errors.push("assignmentCompletionRate must be a number between 0 and 100");
  }
  // Teacher notes can be empty, but the type must be consistent for prompt construction.
  if (typeof teacherNotes !== "string") {
    errors.push("teacherNotes must be a string");
  }
  if (!performanceTrend) {
    errors.push("performanceTrend must be improving, stable, or declining");
  }
  if (!isValidDate(lastAssessmentDate)) {
    errors.push("lastAssessmentDate must be a valid date string");
  }

  // Returning structured errors lets callers decide whether to fail fast or continue with the valid subset.
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      id: idValue,
      name: nameValue,
      email: emailValue,
      grades: validatedGrades,
      participationScore: participationValue,
      assignmentCompletionRate: completionValue,
      teacherNotes: notesValue,
      performanceTrend: trendValue,
      lastAssessmentDate: lastAssessmentValue,
    },
  };
}

/**
 * Validate a JSON payload that should be a list of students.
 */
export function validateStudents(data: unknown): { valid: Student[]; errors: string[] } {
  // This function intentionally does *not* throw: it returns a split of `valid` + `errors`.
  const errors: string[] = [];
  const valid: Student[] = [];

  if (!Array.isArray(data)) {
    return {
      valid,
      errors: ["students.json must be an array of student objects"],
    };
  }

  data.forEach((value, index) => {
    const result = validateStudent(value, index);
    if (result.ok) {
      valid.push(result.value);
    } else {
      // Prefix each error with the array location so the raw JSON can be fixed quickly.
      result.errors.forEach((error) => {
        errors.push(`students[${index}]: ${error}`);
      });
    }
  });

  return { valid, errors };
}
