#!/usr/bin/env bash
# Manual integration test for the LLM agent. Run AFTER setting up .env locally:
#   GEMINI_API_KEY=<your free AI Studio key>
#   BOT_AGENT_MODE=shadow   (or live)
#
# Usage:
#   npm run server   (in another terminal)
#   ./scripts/test-agent-local.sh

set -euo pipefail

BASE="http://localhost:3000"

echo "=== /health ==="
curl -s "$BASE/health" | python3 -m json.tool || curl -s "$BASE/health"

echo ""
echo "=== Conversation A: happy path (test1) ==="
for msg in "hi" "rahul" "delhi se hoon" "meri power -2.5 hai" "kitne ka padega?" "call me"; do
  echo "--- inbound: $msg ---"
  curl -s -X POST "$BASE/chat" -H 'Content-Type: application/json' \
    -d "{\"phone\":\"test1\",\"message\":\"$msg\"}" | python3 -m json.tool 2>/dev/null || \
  curl -s -X POST "$BASE/chat" -H 'Content-Type: application/json' \
    -d "{\"phone\":\"test1\",\"message\":\"$msg\"}"
  echo ""
  sleep 1
done

echo ""
echo "=== Conversation B: Hinglish (test2) ==="
for msg in "surgery kab kar sakte hain" "mera naam amit hai" "recovery kitne din ki hai"; do
  echo "--- inbound: $msg ---"
  curl -s -X POST "$BASE/chat" -H 'Content-Type: application/json' \
    -d "{\"phone\":\"test2\",\"message\":\"$msg\"}"
  echo ""
  sleep 1
done

echo ""
echo "=== Conversation C: cataract trap (test3) ==="
echo "--- inbound: main 66 ka hoon, door ka nahi dikhta ---"
curl -s -X POST "$BASE/chat" -H 'Content-Type: application/json' \
  -d '{"phone":"test3","message":"main 66 ka hoon, door ka nahi dikhta"}'
echo ""

echo ""
echo "=== Conversation D: abuse mid-conversation (test4) ==="
curl -s -X POST "$BASE/chat" -H 'Content-Type: application/json' -d '{"phone":"test4","message":"hi"}'
echo ""
curl -s -X POST "$BASE/chat" -H 'Content-Type: application/json' -d '{"phone":"test4","message":"chutiye ho kya"}'
echo ""

echo ""
echo "Done. Check the server logs for [AGENT:shadow] / [AGENT:live] / [AGENT:fallback] lines."
echo "In shadow mode, the curl output above is the RULE-BASED reply; the agent reply is in the server log."
