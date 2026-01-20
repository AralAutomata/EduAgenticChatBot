import {
  parseStudentInsights,
  parseTeacherInsights,
  renderStudentMessage,
} from "../src/insights.ts";
import { assertEquals, assert } from "jsr:@std/assert@0.224.0";

/**
 * Unit tests for LLM output parsing and rendering helpers.
 *
 * The key behaviors:
 * - Valid JSON contracts are accepted and produce renderable messages.
 * - Invalid JSON contracts are rejected so callers can fall back deterministically.
 */
Deno.test("parseStudentInsights accepts valid JSON", () => {
  // A minimal but valid payload: required fields + array sizes meet the contract.
  const raw = `
    {
      "positiveObservation": "You showed steady effort this week.",
      "strengths": ["Consistent participation"],
      "improvementAreas": ["Assignment organization"],
      "strategies": ["Use a checklist", "Review notes for 15 minutes nightly"],
      "nextStepGoal": "Complete all assignments on time this week.",
      "encouragement": "Small steps add up."
    }
  `;

  const result = parseStudentInsights(raw);
  assert(result.ok);
  if (result.ok) {
    // Rendering should include stable section labels used by the email template.
    const message = renderStudentMessage(result.value);
    assert(message.includes("Strengths:"));
  }
});

Deno.test("parseStudentInsights rejects invalid JSON", () => {
  // Missing required fields and arrays; contract validation should fail.
  const raw = `{ "positiveObservation": "Good job" }`;
  const result = parseStudentInsights(raw);
  assertEquals(result.ok, false);
});

Deno.test("parseTeacherInsights accepts valid JSON", () => {
  // Teacher payload includes a nested attentionNeeded array of objects.
  const raw = `
    {
      "classOverview": "The class is steady overall.",
      "strengths": ["Strong engagement in discussions"],
      "attentionNeeded": [
        { "name": "Alex", "reason": "Declining trend in assignments" }
      ],
      "nextSteps": ["Short daily review", "Peer support pairs"]
    }
  `;

  const result = parseTeacherInsights(raw);
  assert(result.ok);
});
