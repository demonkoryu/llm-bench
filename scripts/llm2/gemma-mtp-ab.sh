#!/usr/bin/env bash
# Gemma4 MTP speculative-decode A/B — validation for llama.cpp PR #23398.
#
# Runs ON llm2. Starts llama-server (via start-server.sh) from an ISOLATED PR-branch
# build (VK_BIN override → ~/llama.cpp-mtp/build-vulkan), leaving the production
# binaries untouched, and measures decode t/s + draft acceptance with the MTP drafter
# ON vs OFF. KV cache stays q8_0 (start-server.sh default) — this is exactly the
# config that triggered the PR's "0% acceptance with quantized KV" bug, so a non-zero
# acceptance here is the key proof the Hadamard-rotation fix works.
#
# Usage: bash gemma-mtp-ab.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT=8090
URL="http://127.0.0.1:$PORT"
VK_BIN_MTP="$HOME/llama.cpp-mtp/build-vulkan/bin/llama-server"
DRAFT="$HOME/drafters/gemma-4-12B-it-MTP-Q8_0.gguf"
HF_REPO="unsloth/gemma-4-12b-it-GGUF"
HF_FILE="gemma-4-12b-it-Q5_K_M.gguf"
CTX=8192
MAXTOK=512
REPS=3

CODE_PROMPT='Write a complete, well-commented Python implementation of an LRU cache class with O(1) get and put, using a doubly linked list plus a dict. Output only the code.'
PROSE_PROMPT='Explain in detail how TCP congestion control works: the three-way handshake, slow start, congestion avoidance, fast retransmit and fast recovery. Write several paragraphs.'

wait_healthy() {
   for _ in $(seq 1 120); do
      code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/health" 2>/dev/null || echo 000)
      [ "$code" = "200" ] && return 0
      sleep 2
   done
   echo "  [ab] server did not become healthy" >&2
   return 1
}

# Send one chat completion, print "tps<TAB>accept<TAB>drafted" (accept/drafted blank if no spec).
measure() {
   local prompt="$1"
   local body
   body=$(curl -s "$URL/v1/chat/completions" -H 'Content-Type: application/json' -d "$(python3 -c '
import json,sys
print(json.dumps({"model":"local","messages":[{"role":"user","content":sys.argv[1]}],"temperature":0.0,"max_tokens":int(sys.argv[2]),"stream":False}))
' "$prompt" "$MAXTOK")")
   echo "$body" | python3 -c '
import json,sys
d=json.load(sys.stdin)
t=d.get("timings",{}) or {}
tps=t.get("predicted_per_second")
# draft fields drift across versions — match defensively
def g(*ks):
    for k in ks:
        v=t.get(k)
        if isinstance(v,(int,float)): return v
    return None
drafted=g("draft_n","n_draft","n_drafted")
acc=g("draft_n_accepted","n_draft_accepted","n_accept","n_accepted")
rate=(acc/drafted) if (drafted and acc is not None) else None
def s(x):
    return "" if x is None else str(x)
sys.stdout.write("\t".join([s(tps),s(rate),s(drafted)])+"\n")
keys=[k for k in t if "draft" in k.lower() or "accept" in k.lower()]
if keys: sys.stderr.write("draft-keys: "+",".join(keys)+"\n")
'
}

run_config() {
   local tag="$1"; shift
   local extra="$*"
   echo ""
   echo "--- config: $tag   (extra: ${extra:-none})"
   VK_BIN="$VK_BIN_MTP" bash "$HERE/start-server.sh" --backend vulkan --ctx "$CTX" \
      --hf-repo "$HF_REPO" --hf-file "$HF_FILE" $extra >/tmp/mtp-ab-start.log 2>&1
   if ! wait_healthy; then
      echo "  $tag: LOAD FAILED"; tail -20 /tmp/llamasrv.log 2>/dev/null | sed 's/^/    /'
      return
   fi
   for label in code prose; do
      [ "$label" = code ] && p="$CODE_PROMPT" || p="$PROSE_PROMPT"
      measure "$p" >/dev/null 2>&1   # warmup (discarded)
      local sum_tps=0 sum_acc=0 n_acc=0 last_draft=""
      for _ in $(seq 1 "$REPS"); do
         IFS=$'\t' read -r tps rate drafted < <(measure "$p")
         [ -n "$tps" ] && sum_tps=$(python3 -c "print($sum_tps+$tps)")
         if [ -n "$rate" ]; then sum_acc=$(python3 -c "print($sum_acc+$rate)"); n_acc=$((n_acc+1)); fi
         last_draft="$drafted"
      done
      local avg_tps avg_acc
      avg_tps=$(python3 -c "print(f'{$sum_tps/$REPS:.1f}')")
      if [ "$n_acc" -gt 0 ]; then
         avg_acc=$(python3 -c "print(f'{100*$sum_acc/$n_acc:.1f}% accept')")
      else
         avg_acc="no-draft"
      fi
      echo "    $label: $avg_tps t/s  ($avg_acc)"
   done
}

echo "Gemma4-12B Q5_K_M · MTP A/B · PR-branch build $($VK_BIN_MTP --version 2>&1 | grep -o 'version: [0-9]*' | head -1)"
echo "draft=$DRAFT  KV=q8_0 (start-server default)  reps=$REPS max_tokens=$MAXTOK"

run_config "off"      ""
run_config "mtp-n4"   "--model-draft $DRAFT --spec-type draft-mtp --spec-draft-n-max 4"
run_config "mtp-n6"   "--model-draft $DRAFT --spec-type draft-mtp --spec-draft-n-max 6"

echo ""
echo "stopping server..."
bash "$HERE/stop-server.sh" --port "$PORT" >/dev/null 2>&1 || true
pkill -9 -f llama-server 2>/dev/null || true
echo "done"
