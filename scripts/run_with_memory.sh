#!/usr/bin/env bash
set -euo pipefail

# Convenience runner for the memory-enabled pipeline entry point (`src/main_with_memory.ts`).
#
# Why set DENO_DIR:
# - Deno’s cache and some FFI artifacts can require write access.
# - Keeping the cache inside the repo (`.deno_dir`) makes demos self-contained and avoids global state.

# Run the memory-enabled entry point with local Deno cache + required permissions.
# DENO_DIR keeps the cache inside the project so FFI binaries are writable.
DENO_DIR=.deno_dir deno run --allow-read --allow-env --allow-net --allow-write --allow-ffi src/main_with_memory.ts
