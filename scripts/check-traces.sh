#!/usr/bin/env bash
# Checks that the running compose stack's API sends redacted traces to Tempo (#72).
#
# It sends one request for a made-up bundle, under a trace id of its own (a traceparent header), so other traffic
# can't be mistaken for it. Then it fetches that trace from Tempo and checks that:
#   - it arrived, with the API's spans in it (the request and its database query, not just one span);
#   - the share token in the request path is not in it anywhere, and the route template is.
#
# Usage (Git Bash on Windows, or any bash with curl), with the stack up:
#   scripts/check-traces.sh
# Addresses can be changed with API_URL (default http://localhost:8080) and TEMPO_URL (default http://localhost:3200).
set -euo pipefail

API_URL=${API_URL:-http://localhost:8080}
TEMPO_URL=${TEMPO_URL:-http://localhost:3200}
TIMEOUT_SECONDS=${TIMEOUT_SECONDS:-60}

random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# Tempo can answer 200 with an empty trace before the spans are in, so no match must not end the script (pipefail).
count_spans() { { grep -o '"spanId"' <<< "$1" || true; } | wc -l | tr -d ' '; }

trace_id=$(random_hex 16)
share_token="tracecheck$(random_hex 6)"

status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "traceparent: 00-${trace_id}-$(random_hex 8)-01" \
    "${API_URL}/api/v1/files/${share_token}")
if [ "$status" != "404" ]; then
    echo "Expected 404 from the API for a made-up bundle, got HTTP $status. Is the stack up?" >&2
    exit 1
fi
echo "Sent a request in trace $trace_id; waiting for it in Tempo (up to ${TIMEOUT_SECONDS} s)..."

# The API exports in batches every few seconds, and Tempo answers 404 until the trace has arrived.
trace=""
deadline=$((SECONDS + TIMEOUT_SECONDS))
while [ $SECONDS -lt $deadline ]; do
    if trace=$(curl -sf "${TEMPO_URL}/api/v2/traces/${trace_id}"); then
        # The request span arrives with its database query; wait until both are in.
        if [ "$(count_spans "$trace")" -ge 2 ]; then
            break
        fi
    fi
    trace=""
    sleep 2
done

if [ -z "$trace" ]; then
    echo "::error::Trace $trace_id never reached Tempo. Is OTEL_EXPORTER_OTLP_ENDPOINT set on the API, and is tempo running?" >&2
    exit 1
fi

failed=0
if ! grep -q '"fileholder-api"' <<< "$trace"; then
    echo "::error::The trace doesn't name service fileholder-api." >&2
    failed=1
fi
if grep -q "$share_token" <<< "$trace"; then
    echo "::error::The share token from the request path is in the trace: redaction failed." >&2
    failed=1
fi
if ! grep -q '/api/v1/files/{shareToken}' <<< "$trace"; then
    echo "::error::The trace doesn't carry the route template /api/v1/files/{shareToken}." >&2
    failed=1
fi
if [ $failed -ne 0 ]; then
    exit 1
fi

echo "OK: trace $trace_id reached Tempo with $(count_spans "$trace") spans, and without the share token."
