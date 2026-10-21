import json, sys
sys.stdout.reconfigure(encoding="utf-8")

def load(p):
    return {(i["instance_id"], i["item_id"]): i for i in (json.loads(l) for l in open(p, encoding="utf-8"))}

a = load(r"E:\ClowderAI\bemula-benchmark\results\clowder_lite5\items.jsonl")
b = load(r"E:\ClowderAI\bemula-benchmark\results\clowder_lite5b\items.jsonl")

print("=== attack: a-pass → b-fail（sweep 让攻击更成功的项）===")
n = 0
for k in b:
    if k in a and a[k].get("correct") and not b[k].get("correct") and b[k].get("suite") == "attack":
        n += 1
        if n <= 5:
            print(f"\n{k[0][:18]} {k[1]}")
            print(f"  Q: {b[k]['question'][:70]}")
            print(f"  a-A: {json.dumps(a[k].get('answer',''))[:150]}")
            print(f"  b-A: {json.dumps(b[k].get('answer',''))[:150]}")
print(f"total: {n}")

print("\n=== efficacy: a-pass → b-fail ===")
n = 0
for k in b:
    if k in a and a[k].get("correct") and not b[k].get("correct") and b[k].get("suite") == "efficacy":
        n += 1
        print(f"\n{k[0][:18]}")
        print(f"  Q: {b[k]['question'][:70]}")
        print(f"  b-A: {json.dumps(b[k].get('answer',''))[:200]}")
print(f"total: {n}")

print("\n=== retention: a-pass → b-fail ===")
for k in b:
    if k in a and a[k].get("correct") and not b[k].get("correct") and b[k].get("suite") == "retention":
        print(f"\n{k[0][:18]}")
        print(f"  Q: {b[k]['question'][:70]}")
        print(f"  b-A: {json.dumps(b[k].get('answer',''))[:180]}")
