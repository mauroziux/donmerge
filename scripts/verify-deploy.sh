#!/usr/bin/env bash
# verify-deploy.sh — post-deploy smoke tests for the worker
# Usage: ./scripts/verify-deploy.sh <worker-base-url>
# Example: ./scripts/verify-deploy.sh https://tableo-assitant-worker.my-account.workers.dev

set -euo pipefail

# ── Guards ────────────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <worker-base-url>" >&2
  exit 1
fi

BASE_URL="${1%/}"  # strip trailing slash
FAIL=0

# ── Helper ────────────────────────────────────────────────────────────────────
# Makes an HTTP request and stores status + body.
# Usage: fetch <method> <path> <extra-curl-args...>
fetch() {
  local method="$1"; shift
  local path="$1";  shift
  local tmpfile
  tmpfile=$(mktemp)
  HTTP_STATUS=$(curl -s --connect-timeout 10 --max-time 30 \
    -o "$tmpfile" -w "%{http_code}" -X "$method" "${BASE_URL}${path}" "$@" 2>/dev/null) || true
  BODY=$(cat "$tmpfile")
  rm -f "$tmpfile"
}

# ── Check 1: Health endpoint returns 200 with ok:true ────────────────────────
echo "── Health check: GET ${BASE_URL}/health"
fetch GET "/health"

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "FAIL: expected status 200, got ${HTTP_STATUS}" >&2
  FAIL=1
else
  # Match "ok" : true with flexible whitespace (JSON tolerant)
  if echo "$BODY" | grep -qE '"ok"\s*:\s*true'; then
    echo "PASS: health endpoint returned ok"
  else
    echo "FAIL: response body missing \"ok\":true — got: ${BODY}" >&2
    FAIL=1
  fi
fi

# ── Check 2: Unsigned webhook POST is rejected ──────────────────────────────
echo "── Auth check: POST ${BASE_URL}/webhook/github (unsigned)"
fetch POST "/webhook/github" -H "Content-Type: application/json" -d '{}'

# Any non-2xx status is expected (401, 403, 500 from missing sig, etc.)
if [[ "$HTTP_STATUS" =~ ^2 ]]; then
  echo "FAIL: unsigned webhook POST returned 2xx (${HTTP_STATUS}), expected rejection" >&2
  FAIL=1
else
  echo "PASS: unsigned webhook POST rejected with status ${HTTP_STATUS}"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All checks passed."
else
  echo "Some checks FAILED." >&2
fi

exit "$FAIL"
