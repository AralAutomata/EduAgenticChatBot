# API Contract (Deno Agent)

Base URL: `http://localhost:8000`

All responses are JSON unless otherwise noted. Errors use:

```json
{
  "error": "string",
  "detail": "optional"
}
```

## Health

`GET /health`

Response:

```json
{
  "status": "ok",
  "time": "2024-01-01T00:00:00.000Z"
}
```

## Chat

`POST /v1/chat`

Request:

```json
{
  "sessionId": "optional-session",
  "userId": "user-123",
  "role": "student",
  "message": "How can I improve in math?",
  "studentId": "student-001",
  "context": {
    "course": "Algebra"
  }
}
```

Notes:
- `studentId` is required for `teacher` and `student` roles to personalize by name.
- `admin` cannot include `studentId`.

Response:

```json
{
  "reply": "Supportive response...",
  "memoryUpdated": false,
  "runId": "optional-run-id",
  "usage": {
    "inputTokens": 120,
    "outputTokens": 220,
    "totalTokens": 340,
    "costUsd": 0.0123
  }
}
```

## Analyze

`POST /v1/analyze`

Request:

```json
{
  "scope": "all",
  "dryRun": false
}
```

Response:

```json
{
  "runId": "run-uuid",
  "status": "completed"
}
```

## History

`GET /v1/history?limit=25`

Response:

```json
{
  "runs": [
    {
      "runId": "run-uuid",
      "status": "completed",
      "startedAt": "2024-01-01T00:00:00.000Z",
      "completedAt": "2024-01-01T00:02:00.000Z",
      "studentCount": 10,
      "validStudentCount": 10
    }
  ]
}
```

## Config

`GET /v1/config`

Response:

```json
{
  "openAiModel": "gpt-4",
  "scheduleCron": "",
  "scheduleIntervalMin": 30,
  "memoryDir": "memory",
  "memoryHistoryLimit": 5,
  "studentsJsonPath": "students.json",
  "teacherRulesPath": "teacher_rules.json",
  "historyDbPath": "data/history.db",
  "emailOutDir": "",
  "apiHost": "0.0.0.0",
  "apiPort": 8000,
  "apiCorsOrigin": "*"
}
```

## Students

`GET /v1/students`

Response:

```json
{
  "students": [
    { "id": "S001", "name": "Ava Martinez", "email": "ava.martinez@example.com" }
  ]
}
```

## Student Summary

`GET /v1/students/{studentId}`

Response:

```json
{
  "studentId": "student-001",
  "latestInsights": {
    "positiveObservation": "...",
    "strengths": ["..."],
    "improvementAreas": ["..."],
    "strategies": ["..."],
    "nextStepGoal": "...",
    "encouragement": "..."
  },
  "memory": {
    "summary": "...",
    "strengths": [],
    "improvementAreas": [],
    "goals": [],
    "lastUpdated": "...",
    "history": []
  },
  "lastRunAt": "2024-01-01T00:02:00.000Z"
}
```
