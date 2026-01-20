import { analyzeStudent } from "../src/analyzer.ts";
import type { Student } from "../src/types.ts";
import { assertEquals } from "jsr:@std/assert@0.224.0";

/**
 * Unit tests for the deterministic analyzer.
 *
 * Why test analyzer logic:
 * - Analyzer thresholds are “business logic” that influences risk levels and summaries.
 * - The LLM is non-deterministic; these tests ensure the deterministic foundation stays correct.
 */
Deno.test("analyzeStudent computes averages and risk level", () => {
  // Construct a minimal valid student record with signals that should trigger “high” risk.
  const student: Student = {
    id: "S100",
    name: "Test Student",
    email: "test@example.com",
    grades: [
      { subject: "Math", score: 90 },
      { subject: "English", score: 70 },
    ],
    participationScore: 5,
    assignmentCompletionRate: 60,
    teacherNotes: "Needs confidence in class.",
    performanceTrend: "declining",
    lastAssessmentDate: "2024-09-01",
  };

  // Run the pure analyzer function.
  const analysis = analyzeStudent(student);
  // Average is (90 + 70) / 2 = 80.
  assertEquals(analysis.metrics.averageScore, 80);
  // Highest/lowest subjects should be ordered by score.
  assertEquals(analysis.metrics.highestSubjects[0].subject, "Math");
  assertEquals(analysis.metrics.lowestSubjects[0].subject, "English");
  // Declining trend + low completion should push risk to high.
  assertEquals(analysis.riskLevel, "high");
});
