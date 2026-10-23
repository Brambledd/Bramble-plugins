import json, sys
sys.stdout.reconfigure(encoding="utf-8")
items = [json.loads(l) for l in open(r"E:\ClowderAI\bemula-benchmark\results\clowder_lite5\items.jsonl", encoding="utf-8")]
fails = [i for i in items if i.get("suite") in ("efficacy", "attack") and not i.get("correct")]
print(f"FE+AR failures: {len(fails)}")
for it in fails:
    print(f"\n[{it['suite']}] {it['instance_id'][:20]} {it.get('variant')}")
    print(f"  Q: {it['question'][:80]}")
    print(f"  A: {json.dumps(it.get('answer',''))[:220]}")
