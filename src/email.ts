import { join } from "@std/path";
import type { AppConfig, Student } from "./types.ts";
import type { Logger } from "./logger.ts";

/**
 * “Email” rendering + local delivery simulation.
 *
 * Why email exists in this demo:
 * - It represents a typical output channel for scheduled insights (daily/weekly student updates, teacher digests).
 * - In a workshop environment, we don’t want to integrate a real email provider, so we simulate delivery by:
 *   - logging metadata and content
 *   - optionally writing a `.txt` file to `EMAIL_OUT_DIR` for easy inspection
 *
 * Important: nothing here sends real email. Production delivery would plug into this boundary.
 */
export interface EmailContent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function buildStudentEmail(student: Student, insights: string): EmailContent {
  // Personalize subject to make the artifact “feel real” and to be easy to scan in the output folder.
  const subject = `Your learning update and next steps, ${student.name}`;
  // Trim to avoid trailing whitespace from LLM outputs affecting formatting.
  const trimmedInsights = insights.trim();
  // Plain text is built as a list for readability and to avoid manual newline bugs.
  const text = [
    `Hi ${student.name},`,
    "",
    "Here is a supportive summary of your recent progress, plus a few next steps:",
    "",
    trimmedInsights,
    "",
    "You can do this. Pick one focus to try this week and build from there.",
    "Your Educational Assistant",
  ].join("\n");
  // HTML version is a minimal translation of the plain text; it’s not trying to be a full template engine.
  const html = `
    <p>Hi ${student.name},</p>
    <p>Here is a supportive summary of your recent progress, plus a few next steps:</p>
    <p>${trimmedInsights.replace(/\n/g, "<br />")}</p>
    <p>You can do this. Pick one focus to try this week and build from there.<br />Your Educational Assistant</p>
  `;

  return {
    to: student.email,
    subject,
    text,
    html,
  };
}

export function buildTeacherEmail(teacherEmail: string, summary: string): EmailContent {
  // Teacher summaries are class-level, so we keep a stable subject.
  const subject = "Class performance summary";
  const text = `Hello,\n\n${summary}\n\nBest,\nEducational Assistant`;
  const html = `
    <p>Hello,</p>
    <p>${summary.replace(/\n/g, "<br />")}</p>
    <p>Best,<br />Educational Assistant</p>
  `;

  return {
    to: teacherEmail,
    subject,
    text,
    html,
  };
}

/**
 * Simulate email delivery locally by logging and optionally writing to disk.
 */
export async function sendEmail(
  config: AppConfig,
  email: EmailContent,
  logger: Logger,
): Promise<string | null> {
  // Log metadata at info level; content is debug to avoid flooding logs.
  logger.info("Local email generated", { to: email.to, subject: email.subject });
  logger.debug("Local email content", { text: email.text });

  // When no out dir is configured, this becomes a “log-only” sink.
  if (!config.emailOutDir) {
    return null;
  }

  // Make a filename-safe recipient token so the output directory remains browsable.
  const safeRecipient = email.to.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Timestamp is included so files sort by time and avoid collisions across runs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Store the plain text output in a mail-like format for debugging and readability.
  const output = [
    `From: ${config.emailFrom}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    "",
    email.text,
    "",
  ].join("\n");

  try {
    // Create the output directory if needed; this keeps the demo “one command to run”.
    await Deno.mkdir(config.emailOutDir, { recursive: true });
    // Use createNew + UUID suffix to avoid overwriting even when runs occur in the same second.
    const path = await writeUniqueEmailFile(config.emailOutDir, `${timestamp}-${safeRecipient}`, output);
    logger.info("Local email saved", { path });
    return path;
  } catch (error) {
    logger.error("Failed to save local email", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
}

async function writeUniqueEmailFile(dir: string, baseName: string, contents: string): Promise<string> {
  // TextEncoder is the standard bridge from string → bytes in the Web/Deno runtime.
  const encoder = new TextEncoder();

  // Retry loop exists because we use createNew, and a collision is theoretically possible.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const uniqueSuffix = crypto.randomUUID();
    const fileName = `${baseName}-${uniqueSuffix}.txt`;
    const path = join(dir, fileName);

    try {
      // createNew ensures we never overwrite an existing artifact.
      const file = await Deno.open(path, { write: true, createNew: true });
      try {
        await file.write(encoder.encode(contents));
      } finally {
        // Always close handles (important in long-running scheduled processes).
        file.close();
      }
      return path;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        continue;
      }
      throw error;
    }
  }

  // If we got here, something is very wrong (e.g., filesystem constraints); fail so the caller can record it.
  throw new Error("Failed to create a unique email file");
}
