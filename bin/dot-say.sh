#!/bin/sh
# dot-say.sh — inject a scheduled turn into the gentle-dot conversation.
# Host wrapper: runs dot-say.js inside the container as root (it needs the
# root-owned daemon token; the engine user cannot and must not self-inject).
# Usage: dot-say.sh "<prompt>" [timeout_minutes]
set -eu
PROMPT="${1:?usage: dot-say.sh \"<prompt>\" [timeout_minutes]}"
TIMEOUT="${2:-10}"
exec docker exec gentle-dot-gentle-dot-1 node /home/dot/bin/dot-say.js "$PROMPT" "$TIMEOUT"
