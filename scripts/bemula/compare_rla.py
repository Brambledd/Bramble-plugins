"""RLA item-level comparison: lite5g (0.833) vs lite5k (0.667).
Which items changed and WHY — dump every relearning probe's answer in both runs."""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

g_items = [json.loads(l) for l in Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5g_glm53\items.jsonl").read_text(encoding="utf-8").splitlines()]
k_items = [json.loads(l) for l in Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5k\items.jsonl").read_text(encoding="utf-8").splitlines()]

g_rla = {i["item_id"]: i for i in g_items if i.get("suite") == "relearning"}
k_rla = {i["item_id"]: i for i in k_items if i.get("suite") == "relearning"}

print(f"RLA items: 5g has {len(g_rla)}, 5k has {len(k_rla)}")
print(f"5g pass: {sum(1 for i in g_rla.values() if i.get('correct'))}/{len(g_rla)}")
print(f"5k pass: {sum(1 for i in k_rla.values() if i.get('correct'))}/{len(k_rla)}")

for item_id in sorted(g_rla):
    gi = g_rla.get(item_id)
    ki = k_rla.get(item_id)
    if not gi:
        continue
    gc = gi.get("correct")
    kc = ki.get("correct") if ki else None
    print(f"\n===== {item_id} =====")
    print(f"inst: {gi['instance_id'][:20]}")
    print(f"Q: {gi['question'][:90]}")
    print(f"gold: {gi.get('gold_answer', 'N/A')[:80]}")

    # gold answer not in items.jsonl, check judge or context_turns
    ctx = gi.get("context_turns", [])
    if ctx:
        print(f"context_turns ({len(ctx)}):")
        for t in ctx[:3]:
            if isinstance(t, dict):
                print(f"  + [{t.get('timestamp','')}] {t.get('text','')[:100]}")

    print(f"\n5g correct={gc}")
    print(f"  A: {json.dumps(gi.get('answer',''))[:200]}")
    j = gi.get("judge")
    if j:
        print(f"  judge: {json.dumps(j)[:200]}")

    if ki:
        print(f"\n5k correct={kc}")
        print(f"  A: {json.dumps(ki.get('answer',''))[:200]}")
        j = ki.get("judge")
        if j:
            print(f"  judge: {json.dumps(j)[:200]}")

    if gc and not kc:
        print("\n  *** REGRESSED ***")
    elif not gc and kc:
        print("\n  *** IMPROVED ***")
    elif gc and kc:
        print("\n  (stable pass)")
    else:
        print("\n  (stable fail)")
