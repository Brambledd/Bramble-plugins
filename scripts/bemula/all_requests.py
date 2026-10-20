"""Check all instances' forget requests and their types to understand PR
failure distribution across request types."""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

data = Path(r"E:\ClowderAI\bemula-benchmark\data\lite")
for line in (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()[:5]:
    inst = json.loads(line)
    iid = inst["instance_id"]
    reqs = inst["forget_requests"]
    print(f"{iid}:")
    for r in reqs:
        print(f"  [{r['forget_type']}] targets={len(r.get('target_fact_ids', []))}: {r['request_text'][:95]}")
    print()
