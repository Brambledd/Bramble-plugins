import json
import sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8")


def load(p):
    return {
        (i["instance_id"], i["item_id"]): i
        for i in (json.loads(l) for l in open(p, encoding="utf-8"))
    }


a = load(r"E:\ClowderAI\bemula-benchmark\results\clowder_lite5\items.jsonl")
c = load(r"E:\ClowderAI\bemula-benchmark\results\clowder_lite5c\items.jsonl")

# 1. retention 翻转
for k in sorted(a):
    if a[k].get("suite") == "retention" and k in c:
        ap, cp = a[k].get("correct", False), c[k].get("correct", False)
        if ap != cp:
            print(f"retention 翻转: {k[0][:20]} a={ap} c={cp}")
            print(f"  Q: {c[k].get('question','')[:60]}")
            print(f"  a-A: {json.dumps(a[k].get('answer',''))[:140]}")
            print(f"  c-A: {json.dumps(c[k].get('answer',''))[:140]}")

# 2. FE 回归明细（a对c错）
print("\n=== FE: a-pass → c-fail ===")
n = 0
for k in sorted(a):
    if a[k].get("suite") == "efficacy" and k in c:
        if a[k].get("correct") and not c[k].get("correct"):
            n += 1
            print(f"\n{k[0][:18]}")
            print(f"  Q: {c[k].get('question','')[:70]}")
            print(f"  c-A: {json.dumps(c[k].get('answer',''))[:180]}")
print(f"total: {n}")
