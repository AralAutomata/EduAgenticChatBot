import { validateStudents } from "../src/validator.ts";
import { assertEquals, assert } from "jsr:@std/assert@0.224.0";

/**
 * Unit tests for input validation.
 *
 * The key behavior we want:
 * - Invalid records are rejected with errors.
 * - Valid records still pass through so the pipeline can partially succeed.
 */
Deno.test("validateStudents filters invalid records", () => {
  // Include one fully valid record and one intentionally broken record.
  const data = [
    {
      id: "S1",
      name: "Valid Student",
      email: "valid@example.com",
      grades: [
        { subject: "Math", score: 88 },
      ],
      participationScore: 7,
      assignmentCompletionRate: 92,
      teacherNotes: "Doing well.",
      performanceTrend: "improving",
      lastAssessmentDate: "2024-09-01",
    },
    {
      // Invalid fields: empty id, non-email, empty grades, out-of-range numbers, wrong types, etc.
      id: "",
      name: "Invalid Student",
      email: "not-an-email",
      grades: [],
      participationScore: 11,
      assignmentCompletionRate: -5,
      teacherNotes: 42,
      performanceTrend: "unknown",
      lastAssessmentDate: "bad-date",
    },
  ];

  const result = validateStudents(data);
  // Only the first student should survive validation.
  assertEquals(result.valid.length, 1);
  // We expect at least one validation error from the invalid record.
  assert(result.errors.length > 0);
});
