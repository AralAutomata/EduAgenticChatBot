import { chatRequestSchema } from "@edu/shared-types/schemas";
import type { ApiError, ChatResponse } from "@edu/shared-types/contracts";

/**
 * Next.js API Route: `POST /api/chat`
 *
 * This is a server-side proxy that:
 * - validates the browser payload with a shared Zod schema
 * - forwards it to the Deno backend (`/v1/chat`)
 * - returns the backend response verbatim to the browser
 *
 * Why proxy instead of calling Deno from the browser?
 * - Keeps the browser decoupled from backend networking/CORS.
 * - Makes deployment flexible (UI can be hosted separately).
 * - Keeps “backend-only” concerns (secrets, permissions, storage) on the Deno side.
 */
const agentUrl = process.env.DENO_AGENT_URL ?? "http://localhost:8000";

export async function POST(request: Request) {
  let payload: unknown;
  try {
    // Parse JSON from the incoming browser request.
    payload = await request.json();
  } catch {
    // Normalize parse errors into the shared `{ error, detail? }` shape.
    return Response.json<ApiError>(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  // Validate payload contract at the boundary so the backend can assume the basics are present.
  const parsed = chatRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json<ApiError>(
      { error: "Invalid chat request", detail: parsed.error.message },
      { status: 400 }
    );
  }

  try {
    // Forward request to the Deno agent. We keep the payload unchanged to preserve the contract.
    const upstream = await fetch(`${agentUrl}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data)
    });

    // Read as text (not JSON) so we can pass through errors/non-JSON payloads without guessing.
    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") ?? "application/json";

    // Return the upstream response body + status code as-is.
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": contentType }
    });
  } catch (error) {
    // Network errors: the UI can display a clear “backend unreachable” message.
    return Response.json<ApiError>(
      {
        error: "Failed to reach Deno agent",
        detail: error instanceof Error ? error.message : String(error)
      },
      { status: 502 }
    );
  }
}

export type { ChatResponse };
