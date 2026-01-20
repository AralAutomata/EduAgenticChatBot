import type { ApiError, StudentListResponse } from "@edu/shared-types/contracts";

/**
 * Next.js API Route: `GET /api/students`
 *
 * Proxy to the Deno agent’s `GET /v1/students`.
 *
 * Why this exists:
 * - The browser needs a list of student IDs + names for the dropdown.
 * - The Deno backend intentionally returns a safe subset (no grades) for UI selection.
 */
const agentUrl = process.env.DENO_AGENT_URL ?? "http://localhost:8000";

export async function GET() {
  try {
    const upstream = await fetch(`${agentUrl}/v1/students`, {
      headers: { "content-type": "application/json" }
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") ?? "application/json";

    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": contentType }
    });
  } catch (error) {
    return Response.json<ApiError>(
      {
        error: "Failed to reach Deno agent",
        detail: error instanceof Error ? error.message : String(error)
      },
      { status: 502 }
    );
  }
}

export type { StudentListResponse };
