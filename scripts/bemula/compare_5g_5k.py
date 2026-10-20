"""Full 5g vs 5k comparison with detailed analysis."""
import json
from pathlib import Path

g = [json.loads(l) for l in Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5g_glm53\items.jsonl").read_text(encoding="utf-8").splitlines()]
k = [json.loads(l) for l in Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5k\items.jsonl").read_text(encoding="utf-8").splitlines()]

# index by (instance, item_id)
def index_by_key(items):
    out = {}
    for it in items:
        key = (it.get("instance_id", ""), it.get("item_id", ""))
        out[key] = it
    return out

g_idx = index_by_key(g)
k_idx = index_by_key(k)

print("===== SCORE COMPARISON =====")
print(f"{'suite':14s} {'5g':>6s} {'5k':>6s} {'delta':>7s}")
for suite in ("retention", "efficacy", "preservation", "relearning", "attack"):
    g_suite = [i for i in g if i.get("suite") == suite]
    k_suite = [i for i in k if i.get("suite") == suite]
    g_pass = sum(1 for i in g_suite if i.get("correct"))
    k_pass = sum(1 for i in k_suite if i.get("correct"))
    g_rate = g_pass / len(g_suite) if g_suite else 0
    k_rate = k_pass / len(k_suite) if k_suite else 0
    delta = k_rate - g_rate
    arrow = "↑" if delta > 0 else ("↓" if delta < 0 else "=")
    print(f"{suite:14s} {g_rate:6.3f} {k_rate:6.3f} {delta:+7.3f} {arrow}  n={len(g_suite)}")

print("\n===== ITEM-LEVEL CHANGES =====")
fixed, regressed, stable = [], [], []
for key in g_idx:
    if key not in k_idx:
        continue
    gi = g_idx[key]
    ki = k_idx[key]
    gc = gi.get("correct", False)
    kc = ki.get("correct", False)
    if gc == kc:
        stable.append(key)
    elif kc and not gc:
        fixed.append((key, gi, ki))
    else:
        regressed.append((key, gi, ki))

print(f"fixed: {len(fixed)} | regressed: {len(regressed)} | stable: {len(stable)}")

if fixed:
    print("\n--- FIXED (was wrong, now correct) ---")
    for (iid, item_id), gi, ki in fixed:
        suite = gi.get("suite", "")
        print(f"  [{suite}] {iid[:20]}  {gi.get('question','')[:60]}")
        print(f"    old A: {json.dumps(gi.get('answer',''))[:120]}")
        print(f"    new A: {json.dumps(ki.get('answer',''))[:120]}")

if regressed:
    print("\n--- REGRESSED (was correct, now wrong) ---")
    for (iid, item_id), gi, ki in regressed:
        suite = gi.get("suite", "")
        print(f"  [{suite}] {iid[:20]}  {gi.get('question','')[:60]}")
        print(f"    old A: {json.dumps(gi.get('answer',''))[:120]}")
        print(f"    new A: {json.dumps(ki.get('answer',''))[:120]}")
