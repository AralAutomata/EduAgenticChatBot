#!/usr/bin/env bash
set -euo pipefail

# Developer convenience script:
# - Starts the Deno API server from repo root
# - Starts the Next.js UI using Bun
# - Keeps both running until you Ctrl-C
#
# Notes on the shell mechanics:
# - Each command runs in a subshell so environment changes (like `cd`) don't leak.
# - `&` backgrounds each process, and `wait` keeps the script alive until both exit.

# Run the Deno agent API server (from repo root)
( deno task serve ) &

# Run the Next.js app with Bun
( cd apps/chat-ui && bun run dev ) &

wait
