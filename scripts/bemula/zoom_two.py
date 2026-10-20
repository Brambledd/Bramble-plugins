"""Zoom: profile-0015 (FE leak) and profile-0006 (PR over-deletion) —
dump their forget requests and store composition to find the mechanism."""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

data = Path(r"E:\ClowderAI\bemula-benchmark\data\lite")
insts = {}
for line in (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()[:5]:
    i = json.loads(line)
    insts[i["instance_id"]] = i

for iid in ["profile-0015:inst0", "profile-0006:inst0"]:
    inst = insts[iid]
    print(f"===== {iid} =====")
    for r in inst["forget_requests"]:
        print(f"  [{r['forget_type']}/{r.get('style')}] {r['request_text'][:130]}")
        print(f"      targets({len(r.get('target_fact_ids', []))}): {r.get('target_fact_ids')}")
    print()
