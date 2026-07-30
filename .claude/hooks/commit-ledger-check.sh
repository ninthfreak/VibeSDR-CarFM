#!/usr/bin/env bash
# Stop — surface commits that landed this turn, so ledger drift becomes visible
# to the USER instead of only to Claude, who demonstrably reads past reminders.
#
# LIMIT, stated plainly: a shell hook cannot see the task list, so this cannot
# verify a task was updated. It reports that commits happened and names them.
# The check is the human reading it.
set -uo pipefail
cat >/dev/null   # drain stdin

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

state="$root/.git/claude-last-seen-head"
now=$(git rev-parse HEAD 2>/dev/null) || exit 0
prev=$(cat "$state" 2>/dev/null || echo "")
printf '%s' "$now" > "$state"

# First run in a clone, or nothing new: stay quiet.
[ -z "$prev" ] && exit 0
[ "$prev" = "$now" ] && exit 0
git cat-file -e "$prev" 2>/dev/null || exit 0

n=$(git rev-list --count "$prev".."$now" 2>/dev/null || echo 0)
[ "$n" -eq 0 ] && exit 0

subjects=$(git log --format='  %h %s' "$prev".."$now" 2>/dev/null | head -10)
jq -n --arg m "$n commit(s) landed this turn — confirm the task list reflects them:
$subjects" '{systemMessage:$m}'
