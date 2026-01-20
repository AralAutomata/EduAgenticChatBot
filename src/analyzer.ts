import type { Student, StudentAnalysis, StudentMetrics, TeacherSummary } from "./types.ts";

/**
 * Deterministic analysis engine.
 *
 * Key idea:
 * - Everything in this module is “pure”: no file I/O, no network calls, no database.
 * - That purity makes the behavior predictable, testable, and safe to run repeatedly.
 *
 * How it fits in the system:
 * - The output (`StudentAnalysis`, `TeacherSummary`) becomes prompt context for the LLM.
 * - Fallback logic can also use these deterministic outputs when the LLM is unavailable or misbehaves.
 */
function average(scores: number[]): number {
  // Defensive default: callers generally pass non-empty arrays, but we avoid divide-by-zero anyway.
  if (scores.length === 0) return 0;
  // Standard arithmetic mean.
  const sum = scores.reduce((acc, score) => acc + score, 0);
  // Round to two decimals for stable, human-friendly output (avoids noisy floats like 83.3333333333).
  return Math.round((sum / scores.length) * 100) / 100;
}

function topN<T>(items: T[], n: number, score: (item: T) => number): T[] {
  // Copy before sort so callers don’t experience unexpected mutations.
  return [...items].sort((a, b) => score(b) - score(a)).slice(0, n);
}

function bottomN<T>(items: T[], n: number, score: (item: T) => number): T[] {
  // Same pattern as topN, but ascending.
  return [...items].sort((a, b) => score(a) - score(b)).slice(0, n);
}

function determineRisk(metrics: StudentMetrics, trend: Student["performanceTrend"]): StudentAnalysis["riskLevel"] {
  // This risk model is intentionally simple and explainable:
  // - “high” triggers when any strong negative signal is present
  // - “medium” triggers on softer thresholds
  // - otherwise “low”
  //
  // Why thresholds exist at all:
  // - The LLM prompt expects “what to focus on”; coarse bucketing helps teacher triage and summarization.
  if (metrics.averageScore < 70 || metrics.participationScore <= 4 || metrics.assignmentCompletionRate < 70 || trend === "declining") {
    return "high";
  }
  if (metrics.averageScore < 80 || metrics.participationScore <= 6 || metrics.assignmentCompletionRate < 85) {
    return "medium";
  }
  return "low";
}

/**
 * Analyze a student record into structured performance insights.
 */
export function analyzeStudent(student: Student): StudentAnalysis {
  // Convert grade entries into an average signal used by most thresholds.
  const averageScore = average(student.grades.map((grade) => grade.score));
  // Top/bottom subjects are kept small (2) to keep prompt context compact.
  const highestSubjects = topN(student.grades, 2, (grade) => grade.score);
  const lowestSubjects = bottomN(student.grades, 2, (grade) => grade.score);

  const metrics: StudentMetrics = {
    averageScore,
    highestSubjects,
    lowestSubjects,
    participationScore: student.participationScore,
    assignmentCompletionRate: student.assignmentCompletionRate,
    // `needsAttention` is a “quick filter” used for teacher summary generation.
    needsAttention: averageScore < 75 || student.assignmentCompletionRate < 80 || student.performanceTrend === "declining",
  };

  // These arrays become “deterministic prompt hints” and also drive fallback insights.
  const strengths: string[] = [];
  const improvementAreas: string[] = [];

  // Strength rules are phrased as human-readable statements so they can be used directly in messaging.
  if (averageScore >= 85) strengths.push("Strong overall academic performance");
  if (student.participationScore >= 8) strengths.push("Consistent class participation");
  if (student.assignmentCompletionRate >= 90) strengths.push("High assignment completion rate");
  if (student.performanceTrend === "improving") strengths.push("Recent performance trend is improving");

  // Improvement rules bias toward actionability: what can be changed next.
  if (averageScore < 75) improvementAreas.push("Overall grade average needs improvement");
  if (student.participationScore <= 6) improvementAreas.push("Increase class participation");
  if (student.assignmentCompletionRate < 85) improvementAreas.push("Improve assignment completion rate");
  if (student.performanceTrend === "declining") improvementAreas.push("Address recent performance decline");
  if (lowestSubjects.length > 0) {
    // Converting subjects to a comma list keeps this single improvement area compact.
    const subjects = lowestSubjects.map((grade) => grade.subject).join(", ");
    improvementAreas.push(`Focus on weaker subjects: ${subjects}`);
  }

  // Convert metrics/trend into a coarse bucket used by teacher triage.
  const riskLevel = determineRisk(metrics, student.performanceTrend);

  return {
    student,
    metrics,
    strengths,
    improvementAreas,
    riskLevel,
  };
}

export function buildTeacherSummary(analyses: StudentAnalysis[]): TeacherSummary {
  // Class average is an average of student averages (not weighted by number of grade entries).
  const classAverage = average(analyses.map((analysis) => analysis.metrics.averageScore));
  // Sorting by average supports “top students” highlights.
  const sortedByAverage = [...analyses].sort(
    (a, b) => b.metrics.averageScore - a.metrics.averageScore,
  );

  // Keep top list short for readability in summary messages.
  const topStudents = sortedByAverage.slice(0, 3).map((analysis) => analysis.student.name);
  // Attention list combines explicit needsAttention + high risk, so teachers get a concise check-in roster.
  const attentionNeeded = analyses
    .filter((analysis) => analysis.metrics.needsAttention || analysis.riskLevel === "high")
    .map((analysis) => analysis.student.name);

  const notes: string[] = [];
  // Notes are designed to be “lightweight aggregations” that inform teacher messaging.
  const declining = analyses.filter((analysis) => analysis.student.performanceTrend === "declining").length;
  if (declining > 0) notes.push(`${declining} student(s) show a declining trend.`);
  const strongCompletion = analyses.filter((analysis) => analysis.metrics.assignmentCompletionRate >= 90).length;
  if (strongCompletion > 0) notes.push(`${strongCompletion} student(s) have 90%+ assignment completion.`);

  return {
    classAverage,
    topStudents,
    attentionNeeded,
    notes,
  };
}
