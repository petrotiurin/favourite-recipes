#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): run the site's Vitest tests that cover the edited file (`vitest related`: only the test files that import
# it, directly or not), after an edit to the site or to shared/. Silent on success. On failure, prints the failing tests to stderr and
# exits 2 so Claude sees them. The backend's tests are run-mcp-tests.sh.
f=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
root="$(cd "$(dirname "$0")/../.." && pwd)"
rel="${f#"$root"/}"
case "$rel" in
  src/*.ts|src/*.tsx|src/*.astro|shared/*.ts|styles/*.css) ;;
  astro.config.ts|vitest.config.ts|data/ingredients.json) rel="" ;; # affects every test: run them all
  *) exit 0 ;;
esac
cd "$root" || exit 0
if [ ! -d node_modules ]; then echo "site tests skipped: run npm install first" >&2; exit 0; fi
if [ -n "$rel" ]; then
  out=$(npx vitest related "$rel" --run --passWithNoTests 2>&1); code=$?
else
  out=$(npx vitest run 2>&1); code=$?
fi
if [ $code -ne 0 ]; then
  { echo "site tests failed after editing ${f#"$root"/}:"; echo "$out" | grep -E "FAIL|✗|×|AssertionError|Error:|Test Files|Tests " | head -30; } >&2
  exit 2
fi
