"""Full-cause forensics on lite5i: identify every FE and PR failure by
instance and request, classify root cause, and check RLA failures too.
This is the diagnostic BEFORE any fix — understand everything first."""
import json
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

RUN = Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5i")
items = [json.loads(l) for l in (RUN / "items.jsonl").read_text(encoding="utf-8").splitlines()]

# --- classify all forget-variant failures ---
print("========== FE FAILURES ==========")
for it in items:
    if it.get("variant") == "forget" and it.get("suite") == "efficacy" and not it.get("correct"):
        print(f"inst={it['instance_id']}  req={it.get('request_id')}")
        print(f"  Q: {it['question'][:90]}")
        print(f"  A: {json.dumps(it.get('answer',''))[:200]}")
        j = it.get("judge")
        if j:
            print(f"  judge: {json.dumps(j)[:180]}")
        print()

print("========== PR FAILURES ==========")
for it in items:
    if it.get("variant") == "forget" and it.get("suite") == "preservation" and not it.get("correct"):
        print(f"inst={it['instance_id']}")
        print(f"  Q: {it['question'][:90]}")
        print(f"  A: {json.dumps(it.get('answer',''))[:200]}")
        print()

print("========== RLA FAILURES ==========")
for it in items:
    if it.get("suite") == "relearning" and not it.get("correct"):
        print(f"inst={it['instance_id']}  req={it.get('request_id')}")
        print(f"  Q: {it['question'][:90]}")
        print(f"  A: {json.dumps(it.get('answer',''))[:200]}")
        print()

# --- compare with lite5g (previous baseline) for shift detection ---
prev = [json.loads(l) for l in Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5g_glm53\items.jsonl").read_text(encoding="utf-8").splitlines()]
def fail_set(recs, suite):
    return {(r["instance_id"], r["item_id"]) for r in recs if r.get("suite") == suite and not r.get("correct")}

for suite in ("efficacy", "preservation", "relearning"):
    old = fail_set(prev, suite)
    new = fail_set(items, suite)
    fixed = old - new
    regressed = new - old
    print(f"\n===== {suite} shift (5g -> 5i) =====")
    print(f"  fixed ({len(fixed)}): {sorted(fixed)[:6]}")
    print(f"  regressed ({len(regressed)}): {sorted(regressed)[:6]}")
