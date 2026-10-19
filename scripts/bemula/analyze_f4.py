"""F4 (inferential forgetting) failure analysis: dump the F4 instances'
requests, retention failures, and probe questions from both the dataset and
the lite5b run records."""
import json
from pathlib import Path

data = Path(r"E:\ClowderAI\bemula-benchmark\data\lite")
insts = {}
for line in (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()[:5]:
    inst = json.loads(line)
    insts[inst["instance_id"]] = inst

# find instances carrying F4 requests
f4_ids = set()
for iid, inst in insts.items():
    for r in inst.get("forget_requests", []):
        if r.get("forget_type") == "F4":
            f4_ids.add(iid)
print("F4 instances within first 5:", f4_ids)

for iid in sorted(f4_ids):
    inst = insts[iid]
    print(f"\n===== {iid} | sessions={len(inst['sessions'])} | turns/user=",
          sum(1 for s in inst["sessions"] for t in s["turns"] if t["speaker"] == "user"))
    for r in inst["forget_requests"]:
        print(f"  [{r['forget_type']}/{r.get('style')}] {r['request_text'][:120]}")
        print(f"      targets: {r.get('target_fact_ids')}")
    # linked facts of interest: show the target fact surface forms via profile? not in dialogues; use question file
    qfile = (data / "questions.jsonl").read_text(encoding="utf-8").splitlines()
    for line in qfile:
        q = json.loads(line)
        if q["instance_id"] == iid and q.get("suite") in ("retention", "efficacy"):
            print(f"  [{q['suite']}] {q['question'][:100]}")

# run records for F4 instances: what did we answer on retention?
print("\n===== run records (lite5b) for F4 instances =====")
for line in Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5b\items.jsonl").read_text(encoding="utf-8").splitlines():
    item = json.loads(line)
    if item.get("instance_id") in f4_ids and item.get("suite") == "retention":
        print(f"[{item['instance_id']}/{item.get('variant')}] correct={item.get('correct')}")
        print("   Q:", item["question"][:90])
        print("   A:", json.dumps(item.get("answer", ""))[:220])
