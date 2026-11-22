#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): run the mcp-server tests after an edit to a file they cover.
# Silent on success. On failure, prints the failing tests to stderr and exits 2 so Claude sees them.
f=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
root="$(cd "$(dirname "$0")/../.." && pwd)"
case "${f#"$root"/}" in
  mcp-server/lib/*|mcp-server/api/*|mcp-server/test/*|mcp-server/scripts/*|mcp-server/workflows/*|mcp-server/package.json) ;;
  shared/*|templates/chat.cjs|src/lib/shopping-state.ts|src/lib/auth.ts|data/ingredients.json) ;; # checked against the server by its tests
  *) exit 0 ;;
esac
cd "$root/mcp-server" || exit 0
if [ ! -d node_modules ]; then echo "mcp-server tests skipped: run npm install in mcp-server/ first" >&2; exit 0; fi
out=$(npm test 2>&1); code=$?
if [ $code -ne 0 ]; then
  { echo "mcp-server tests failed after editing ${f#"$root"/}:"; echo "$out" | grep -E "^✖|^ℹ (tests|pass|fail)|AssertionError|Error:" | head -30; } >&2
  exit 2
fi
