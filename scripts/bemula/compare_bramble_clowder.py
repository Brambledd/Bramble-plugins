import json, sys
sys.stdout.reconfigure(encoding="utf-8")

def load(p):
    return {(i["instance_id"], i["item_id"]): i for i in (json.loads(l) for l in open(p, encoding="utf-8"))}

c = load(r"E:\ClowderAI\bemula-benchmark\results\clowder_lite5\items.jsonl")
b = load(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5l\items.jsonl")

from collections import Counter
diff = Counter()
examples = {"b_pass_c_fail": [], "b_fail_c_pass": []}
for key in b:
    if key not in c:
        continue
    bc, cc = b[key].get("correct"), c[key].get("correct")
    suite = b[key].get("suite")
    if bc and not cc:
        diff[(suite, "bramble_pass_clowder_fail")] += 1
        if len(examples["b_pass_c_fail"]) < 8:
            examples["b_pass_c_fail"].append((suite, key[0][:18], key[1], b[key].get("question","")[:60]))
    elif cc and not bc:
        diff[(suite, "bramble_fail_clowder_pass")] += 1
        if len(examples["b_fail_c_pass"]) < 8:
            examples["b_fail_c_pass"].append((suite, key[0][:18], key[1], b[key].get("question","")[:60]))

print("=== bramble 通过但 clowder 失败（回归项）===")
for (suite, kind), n in sorted(diff.items()):
    if kind == "bramble_pass_clowder_fail":
        print(f"  [{suite}] {n}")
print("\n--- 回归明细 ---")
for suite, inst, item, q in examples["b_pass_c_fail"]:
    print(f"  [{suite}] {inst} {item}")
    print(f"      {q}")

print("\n=== bramble 失败但 clowder 通过（改善项）===")
for (suite, kind), n in sorted(diff.items()):
    if kind == "bramble_fail_clowder_pass":
        print(f"  [{suite}] {n}")
print("\n--- 改善明细 ---")
for suite, inst, item, q in examples["b_fail_c_pass"]:
    print(f"  [{suite}] {inst} {item}")
    print(f"      {q}")
