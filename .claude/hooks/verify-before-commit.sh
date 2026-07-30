#!/usr/bin/env bash
# PreToolUse(Bash) — refuse `git commit` unless the type-check and the backend
# suite pass. Exists because "I verified it" was a claim; this makes it a
# precondition. Non-commit Bash calls exit 0 immediately and cost nothing.
set -uo pipefail

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Substring, not prefix: commits are usually `git add -A && git commit -m ...`,
# which a prefix matcher would sail straight past.
case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac
# --no-verify is an explicit human override; don't fight it.
case "$cmd" in *"--no-verify"*) exit 0 ;; esac

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root" || exit 0

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",
    permissionDecision:"deny", permissionDecisionReason:$r}}'
  exit 0
}

if ! out=$(npx tsc --noEmit 2>&1); then
  deny "Commit blocked: tsc --noEmit failed.

$(printf '%s' "$out" | head -20)"
fi

if ! out=$(npm run test:backend 2>&1); then
  deny "Commit blocked: npm run test:backend failed.

$(printf '%s' "$out" | grep -Ei 'FAIL|error' | head -20)"
fi

exit 0
