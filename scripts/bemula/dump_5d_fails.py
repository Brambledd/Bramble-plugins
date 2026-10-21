import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
d = [
    i
    for i in (json.loads(l) for l in open(r"E:\ClowderAI\bemula-benchmark\results\clowder_lite5d\items.jsonl", encoding="utf-8"))
    if i.get("variant") == "forget" and i.get("suite") in ("efficacy", "attack") and not i.get("correct")
]
from collections import Counter

inst = Counter(i["instance_id"][:14] for i in d)
print("失败分布:", dict(inst))
for i in d[:6]:
    print()
    print(f"[{i['suite']}] {i['instance_id'][:16]} {i.get('question','')[:60]}")
    print(f"  A: {json.dumps(i.get('answer',''))[:180]}")
