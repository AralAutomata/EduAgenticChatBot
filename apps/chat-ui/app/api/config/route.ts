import type { ApiConfigResponse, ApiError } from "@edu/shared-types/contracts";

/**
 * Next.js API Route: `GET /api/config`
 *
 * This is a transparent proxy to the Deno agent’s `GET /v1/config`.
 *
 * Why expose config to the UI:
 * - The UI can show “what model/schedule/memory settings are active” without needing shell access.
 * - The backend returns only safe values (no API keys).
 */
const agentUrl = process.env.DENO_AGENT_URL ?? "http://localhost:8000";

export async function GET() {
  try {
    // Forward request to the Deno backend.
    const upstream = await fetch(`${agentUrl}/v1/config`, {
      headers: { "content-type": "application/json" }
    });

    // Pass through body and status. Reading as text avoids assumptions about error payloads.
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

export type { ApiConfigResponse };
