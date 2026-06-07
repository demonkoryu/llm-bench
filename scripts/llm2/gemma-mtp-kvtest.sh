#!/usr/bin/env bash
# Diagnostic: does the Gemma4 MTP drafter accept under f16 KV vs q8_0 KV?
# PR #23398 claims the quantized-KV 0%-acceptance bug is fixed (Hadamard rotation),
# but our q8_0 A/B saw ~0% accept on Vulkan/gfx1100. This isolates the KV-quant axis.
set -u
BIN="$HOME/llama.cpp-mtp/build-vulkan/bin/llama-server"
DRAFT="$HOME/drafters/gemma-4-12B-it-MTP-Q8_0.gguf"
M="$(ls "$HOME"/.cache/huggingface/hub/models--unsloth--gemma-4-12b-it-GGUF/snapshots/*/gemma-4-12b-it-Q5_K_M.gguf | head -1)"
PROMPT='Write a complete Python implementation of an LRU cache with O(1) get and put. Output only code.'

run_kv() {
   local ktype="$1"
   pkill -9 -f 'llama-server' 2>/dev/null; sleep 3
   env GGML_VK_DISABLE_INTEGER_DOT_PRODUCT=1 nohup "$BIN" -m "$M" -c 8192 -ngl 99 \
      --cache-type-k "$ktype" --cache-type-v "$ktype" -fa on \
      --model-draft "$DRAFT" --spec-type draft-mtp --spec-draft-n-max 4 \
      --jinja --host 127.0.0.1 --port 8090 > "/tmp/kvtest-$ktype.log" 2>&1 &
   local c=000
   for _ in $(seq 1 90); do
      c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/health 2>/dev/null || echo 000)
      [ "$c" = 200 ] && break; sleep 2
   done
   if [ "$c" != 200 ]; then echo "KV=$ktype: server unhealthy (code=$c)"; tail -15 "/tmp/kvtest-$ktype.log"|sed 's/^/  /'; return; fi
   local body
   body=$(curl -s http://127.0.0.1:8090/v1/chat/completions -H 'Content-Type: application/json' \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"model":"local","messages":[{"role":"user","content":sys.argv[1]}],"temperature":0,"max_tokens":512,"stream":False}))' "$PROMPT")")
   echo "$body" | python3 -c '
import json,sys
d=json.load(sys.stdin); t=d.get("timings",{}) or {}
dn=t.get("draft_n"); da=t.get("draft_n_accepted")
rate=(100*da/dn) if dn else 0
print("KV=%-5s  tps=%5.1f  draft_n=%-5s accepted=%-5s  accept=%.1f%%" % (sys.argv[1], t.get("predicted_per_second",0), dn, da, rate))
' "$ktype"
}

echo "Gemma4-12B Q5_K_M MTP · f16 vs q8_0 KV · $($BIN --version 2>&1|grep -o 'version: [0-9]*'|head -1)"
run_kv f16
run_kv q8_0
pkill -9 -f 'llama-server' 2>/dev/null
echo done
