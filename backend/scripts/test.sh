#!/usr/bin/env sh
# FlowWise test runner (POSIX sh).
#
# Runs each test file sequentially: every file boots its own PGlite (WASM
# PostgreSQL) instance, and running them in parallel exceeds sandbox memory.
#
# Bun 1.3.14 has a teardown quirk where a fully passing PGlite suite can
# exit 99 (genuine failures exit 1), so 99 is treated as success here.
# Note: never gate on `! bun test ...` — POSIX sh sets $? to the INVERTED
# status after `!`, which would always read 0 for a failing command.
#
# --timeout 30000: each file boots a fresh PGlite + Nest app in beforeAll;
# under load that boot can exceed bun's 5s default hook budget, which would
# flake a passing suite with a spurious hook-timeout.
set -u

fail=0
for f in test/*.test.ts; do
  printf '==> %s\n' "$f"
  bun test --timeout 30000 "$f"
  code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 99 ]; then
    printf 'FAILED (%s) with exit code %s\n' "$f" "$code"
    fail=1
  fi
done
exit "$fail"
