#!/usr/bin/env bash
# PreToolUse(Bash) — refuse `git commit` unless the type-check, the backend
# suite, the Rust core and BOTH differentials pass. Exists because "I verified
# it" was a claim; this makes it a precondition. Non-commit Bash calls exit 0
# immediately and cost nothing.
#
# The differentials are the point. docs/HANDOFF.md §6 records that the first cut
# of the Rust port "drifted from the TypeScript reference silently while its own
# tests stayed green", and the differentials were built as the answer. Left to be
# run by hand they detect drift only when someone remembers to ask; wired here
# they are a property of the branch. They cost ~2.8s against a gate already
# costing ~11s, so there is no tradeoff to weigh.
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

# ── the Rust core and the two differentials ─────────────────────────────────
#
# These need cargo, which is exactly why they are NOT part of test:backend —
# that suite is plain node and has to keep running where no Rust toolchain
# exists. So they are skipped when cargo is absent rather than blocking a
# TypeScript-only commit on a machine that could not have built Rust anyway...
# unless the commit actually touches the portable core, in which case skipping
# would be the silent-drift hole this gate exists to close.
if ! command -v cargo >/dev/null 2>&1; then
  if git diff --cached --name-only 2>/dev/null | grep -q '^core/'; then
    deny "Commit blocked: it changes core/ but cargo is not installed, so
cargo test and the differentials cannot run. Install Rust, or drop the core/
changes from this commit."
  fi
  exit 0
fi

if ! out=$(cd core && cargo test 2>&1); then
  deny "Commit blocked: cargo test failed.

$(printf '%s' "$out" | grep -Ei 'FAILED|panicked|^error|assertion' | head -20)"
fi

# Byte-identical, or it fails. Feeds the shipped decoder and the Rust port the
# same generated corpus and diffs the printed state after every step.
if ! out=$(npm run test:rds-diff 2>&1); then
  deny "Commit blocked: the RDS differential diverged — the Rust decoder and
src/services/nwdRds.ts no longer agree.

$(printf '%s' "$out" | grep -Ev '^$' | tail -20)"
fi

# Not a byte comparison: structure must match exactly, numbers to a relative
# 1e-9. tools/tests/stationsDifferential.mjs opens with the reasoning.
if ! out=$(npm run test:stations-diff 2>&1); then
  deny "Commit blocked: the station differential diverged — the Rust port and
the shipped TypeScript no longer agree.

$(printf '%s' "$out" | grep -Ev '^$' | tail -20)"
fi

exit 0
