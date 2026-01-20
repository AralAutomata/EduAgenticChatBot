"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiConfigResponse,
  ChatResponse,
  StudentListResponse,
  StudentProfile
} from "@edu/shared-types/contracts";

/**
 * Main demo UI page.
 *
 * UX goals:
 * - Make it easy to demo “role-aware” behavior (student vs teacher vs admin).
 * - Provide a student selector so the backend can address the student by name.
 * - Keep state simple and local: this UI is intentionally not a full chat product.
 * - Surface operational context (model/schedule/memory) via `/api/config`.
 * - Surface token usage totals when the backend provides them.
 *
 * Why this is a client component:
 * - It uses React hooks and browser APIs (state, effects, scroll refs).
 * - The actual backend calls still happen server-side via Next API routes (`/api/*`).
 */
type Role = "student" | "teacher" | "admin";

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
}

const SMART_PROMPTS: Record<Role, { label: string; text: string }[]> = {
  student: [
    {
      label: "Study plan",
      text: "Can you help me build a study plan for this week with small daily steps?"
    },
    {
      label: "Focus help",
      text: "I keep getting distracted while studying. What should I do today to stay focused?"
    },
    {
      label: "Confidence",
      text: "I feel nervous about my next assessment. How can I prepare and stay calm?"
    }
    ,
    {
      label: "Homework strategy",
      text: "Help me break tonight's homework into quick steps I can finish in 45 minutes."
    },
    {
      label: "Memory tips",
      text: "What are 3 ways I can remember key ideas from today's lesson?"
    },
    {
      label: "Progress check",
      text: "What should I focus on next based on my recent progress?"
    }
  ],
  teacher: [
    {
      label: "Coaching plan",
      text: "Provide a coaching plan for this student with strengths, growth areas, and next steps."
    },
    {
      label: "Intervention",
      text: "Suggest in-class strategies and quick interventions for this student."
    },
    {
      label: "Family note",
      text: "Draft a short family/guardian note with positive tone and clear next steps."
    }
    ,
    {
      label: "Motivation plan",
      text: "Recommend motivation tactics and routines that fit this student."
    },
    {
      label: "Assessment prep",
      text: "Provide a short prep plan for the next assessment focused on this student."
    },
    {
      label: "Small wins",
      text: "List 3 achievable wins for this student this week."
    },
    {
      label: "Behavior support",
      text: "Suggest classroom supports to improve attention and participation for this student."
    }
  ],
  admin: [
    {
      label: "System status",
      text: "Give a concise system status update: model, schedule, last run status, and errors."
    },
    {
      label: "Run health",
      text: "Summarize the last run health and data validity at a high level."
    },
    {
      label: "Ops checklist",
      text: "List the top 3 operational checks to perform today."
    }
    ,
    {
      label: "Schedule audit",
      text: "Confirm the current schedule cadence and whether the last run completed on time."
    },
    {
      label: "Config summary",
      text: "Summarize the active configuration that impacts runs and storage."
    },
    {
      label: "Failure triage",
      text: "If the last run failed, outline likely causes and immediate remediation steps."
    },
    {
      label: "Data quality",
      text: "Give a quick data quality assessment based on validation outcomes."
    }
  ]
};

export default function HomePage() {
  // Unique identifiers are created per browser session so the backend can correlate messages if desired.
  const userId = useMemo(() => crypto.randomUUID(), []);
  const sessionId = useMemo(() => crypto.randomUUID(), []);

  // Role drives UI affordances and backend policy enforcement.
  const [role, setRole] = useState<Role>("student");
  // The backend expects a studentId for teacher/student roles; we update this once we load the student list.
  const [studentId, setStudentId] = useState("student-001");
  const [message, setMessage] = useState("");
  // Chat transcript (client-only). The backend does not store the chat transcript in this demo UI.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);

  // “Config panel” state: what model/schedule/memory settings the backend is currently running with.
  const [config, setConfig] = useState<ApiConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [isConfigLoading, setIsConfigLoading] = useState(false);

  // Student list state drives the dropdown. It’s safe (id/name/email only).
  const [students, setStudents] = useState<StudentProfile[]>([]);
  const [studentsError, setStudentsError] = useState<string | null>(null);

  // Used to auto-scroll the message list on new messages.
  const messagesRef = useRef<HTMLDivElement | null>(null);

  // Token usage state accumulates across the session. The backend may not always provide usage metadata.
  const [usageTotals, setUsageTotals] = useState({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0
  });
  const [hasUsage, setHasUsage] = useState(false);
  const [hasCost, setHasCost] = useState(false);

  const sendMessage = async () => {
    // Avoid sending empty/whitespace-only messages.
    if (!message.trim()) return;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: message.trim()
    };

    // Optimistic UI: add the user message immediately.
    setMessages((prev) => [...prev, userMessage]);
    setMessage("");
    setIsSending(true);

    try {
      // The browser calls Next.js, not Deno. Next then proxies to the Deno agent.
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          userId,
          role,
          message: userMessage.text,
          // Admin role is system-only, so we omit studentId entirely.
          studentId: role !== "admin" ? studentId : undefined
        })
      });

      // The backend returns either a valid ChatResponse or a shared error shape.
      const data = (await response.json()) as ChatResponse | { error?: string; detail?: string };
      if (!response.ok) {
        // Normalize backend errors into a user-friendly string.
        const message =
          typeof data === "object" && data && "error" in data && data.error
            ? data.error + (data.detail ? `: ${data.detail}` : "")
            : "Chat request failed";
        throw new Error(message);
      }

      const agentMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "agent",
        text: (data as ChatResponse).reply
      };
      const usage = (data as ChatResponse).usage;
      if (usage) {
        // Aggregate token/cost totals so a demo session has an at-a-glance cost estimate.
        setUsageTotals((prev) => ({
          inputTokens: prev.inputTokens + usage.inputTokens,
          outputTokens: prev.outputTokens + usage.outputTokens,
          totalTokens: prev.totalTokens + usage.totalTokens,
          costUsd: prev.costUsd + (typeof usage.costUsd === "number" ? usage.costUsd : 0)
        }));
        setHasUsage(true);
        if (typeof usage.costUsd === "number") {
          setHasCost(true);
        }
      }
      setMessages((prev) => [...prev, agentMessage]);
    } catch (error) {
      // Client-side catch covers both network failures and normalized backend errors.
      const agentMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "agent",
        text: error instanceof Error
          ? `Sorry, I couldn't reach the agent: ${error.message}`
          : "Sorry, I couldn't reach the agent."
      };
      setMessages((prev) => [...prev, agentMessage]);
    } finally {
      setIsSending(false);
    }
  };

  const loadConfig = async () => {
    setIsConfigLoading(true);
    setConfigError(null);
    try {
      // Fetch from Next proxy; it forwards to Deno’s `/v1/config`.
      const response = await fetch("/api/config");
      const data = (await response.json()) as ApiConfigResponse;
      if (!response.ok) {
        throw new Error("Failed to load config");
      }
      setConfig(data);
    } catch (error) {
      setConfigError(
        error instanceof Error ? error.message : "Failed to load config"
      );
    } finally {
      setIsConfigLoading(false);
    }
  };

  const loadStudents = async () => {
    setStudentsError(null);
    try {
      // Fetch safe student index from the backend via Next proxy.
      const response = await fetch("/api/students");
      const data = (await response.json()) as StudentListResponse;
      if (!response.ok) {
        throw new Error("Failed to load students");
      }
      setStudents(data.students);
      if (data.students.length > 0) {
        // If the current studentId is invalid (e.g., default placeholder), pick the first available student.
        const firstId = data.students[0].id;
        setStudentId((current) =>
          data.students.some((student) => student.id === current)
            ? current
            : firstId
        );
      }
    } catch (error) {
      setStudentsError(
        error instanceof Error ? error.message : "Failed to load students"
      );
    }
  };

  useEffect(() => {
    // Load config and students on initial mount.
    loadConfig().catch(() => undefined);
    loadStudents().catch(() => undefined);
  }, []);

  useEffect(() => {
    // Auto-scroll to bottom when new messages arrive.
    const container = messagesRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  const resetChat = () => {
    // Reset is intentionally local-only: it clears the UI transcript and usage totals.
    setMessages([]);
    setUsageTotals({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0
    });
    setHasUsage(false);
    setHasCost(false);
  };

  // Smart prompts are role-specific “quick start” messages.
  const smartPrompts = SMART_PROMPTS[role];

  return (
    <main>
      <section className="panel brand">
        <span className="badge">EduAgent Live</span>
        <h1>Classroom Coach Chat</h1>
        <p>
          Connect your Deno agent to this interface and demo personalized guidance
          for students and teachers. The assistant uses memory snapshots to keep
          advice supportive, specific, and practical.
        </p>
        <div className="form">
          <label>
            Role
            <div className="toggle-group" role="group" aria-label="Select role">
              {(["student", "teacher", "admin"] as Role[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`toggle-button ${role === item ? "active" : ""}`}
                  // Role switching is purely UI state; server enforcement still applies.
                  onClick={() => setRole(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </label>
          {role !== "admin" ? (
            <label>
              {role === "teacher" ? "Focus student" : "Student"}
              {students.length > 0 ? (
                <select
                  value={studentId}
                  onChange={(event) => setStudentId(event.target.value)}
                >
                  {students.map((student) => (
                    <option key={student.id} value={student.id}>
                      {student.name} ({student.id})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={studentId}
                  onChange={(event) => setStudentId(event.target.value)}
                  placeholder="S001"
                />
              )}
            </label>
          ) : (
            <p className="helper">Admin is system-only and does not access student data.</p>
          )}
          {role !== "admin" && studentsError ? (
            <p className="helper">{studentsError}</p>
          ) : null}
          <p className="helper">
            Tip: choose a student so the assistant can address them by name.
          </p>
        </div>
        <div className="config-card">
          <div className="config-header">
            <h3>Agent Config</h3>
            <button
              className="button secondary"
              type="button"
              onClick={loadConfig}
              disabled={isConfigLoading}
            >
              {isConfigLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
          {config ? (
            <div className="config-grid">
              <div>
                <span className="config-label">Model</span>
                <span className="config-value">{config.openAiModel}</span>
              </div>
              <div>
                <span className="config-label">Schedule</span>
                <span className="config-value">
                  {config.scheduleCron
                    ? `Cron: ${config.scheduleCron}`
                    : `Every ${config.scheduleIntervalMin} min`}
                </span>
              </div>
              <div>
                <span className="config-label">Memory</span>
                <span className="config-value">
                  {config.memoryDir} (limit {config.memoryHistoryLimit})
                </span>
              </div>
              <div>
                <span className="config-label">Students</span>
                <span className="config-value">{config.studentsJsonPath}</span>
              </div>
              <div>
                <span className="config-label">History DB</span>
                <span className="config-value">{config.historyDbPath}</span>
              </div>
            </div>
          ) : (
            <p className="helper">
              {configError ?? "No config loaded yet."}
            </p>
          )}
        </div>
        <div className="usage-card">
          <div className="usage-header">
            <h3>Token Usage</h3>
            <span className="helper">Session totals</span>
          </div>
          {hasUsage ? (
            <>
              <div className="usage-grid">
                <div>
                  <span className="config-label">Input tokens</span>
                  <span className="config-value">{usageTotals.inputTokens}</span>
                </div>
                <div>
                  <span className="config-label">Output tokens</span>
                  <span className="config-value">{usageTotals.outputTokens}</span>
                </div>
                <div>
                  <span className="config-label">Total tokens</span>
                  <span className="config-value">{usageTotals.totalTokens}</span>
                </div>
                <div>
                  <span className="config-label">Estimated spend</span>
                  <span className="config-value">
                    {hasCost ? `$${usageTotals.costUsd.toFixed(4)}` : "—"}
                  </span>
                </div>
              </div>
              {!hasCost ? (
                <p className="helper">
                  Set `OPENAI_PRICE_INPUT_PER_1K` and `OPENAI_PRICE_OUTPUT_PER_1K`
                  to enable spend estimates.
                </p>
              ) : null}
            </>
          ) : (
            <p className="helper">
              Token usage unavailable.
            </p>
          )}
        </div>
      </section>

      <section className="panel chat-area">
        <header>
          <h2>Conversation</h2>
          <p className="helper">
            Messages are routed through the Next.js API proxy to the Deno agent.
          </p>
        </header>

        <div className="messages" aria-live="polite" ref={messagesRef}>
          {messages.length === 0 ? (
            <div className="message agent">
              Share what you are working on and the assistant will respond with
              targeted guidance.
            </div>
          ) : (
            messages.map((item) => (
              <div key={item.id} className={`message ${item.role}`}>
                {item.text}
              </div>
            ))
          )}
        </div>

        <div className="prompt-card">
          <div className="prompt-header">
            <h3>Smart Prompts</h3>
            <span className="helper">Click to prefill your message.</span>
          </div>
          <div className="prompt-grid">
            {smartPrompts.map((prompt) => (
              <button
                key={prompt.label}
                type="button"
                className="prompt-chip"
                onClick={() => setMessage(prompt.text)}
              >
                {prompt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="form">
          <label>
            Your message
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask about study strategies, progress trends, or classroom planning."
            />
          </label>
          <div className="controls">
            <button className="button" type="button" onClick={sendMessage} disabled={isSending}>
              {isSending ? "Sending..." : "Send"}
            </button>
            <button className="button secondary" type="button" onClick={resetChat}>
              Reset
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
