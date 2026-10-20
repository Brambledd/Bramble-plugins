"""FE + PR failure forensics: for every failed efficacy and preservation item
in the latest run (lite5g), classify WHERE in the forget pipeline the leak
or over-deletion happened."""
import json
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

RUN = Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5g_glm53")
items = [json.loads(l) for l in (RUN / "items.jsonl").read_text(encoding="utf-8").splitlines()]

fe_fail, pr_fail, fe_pass, pr_pass = [], [], [], []
for it in items:
    if it.get("variant") != "forget":
        continue
    if it.get("suite") == "efficacy":
        (fe_pass if it.get("correct") else fe_fail).append(it)
    elif it.get("suite") == "preservation":
        (pr_pass if it.get("correct") else pr_fail).append(it)

print(f"efficacy: {len(fe_pass)} pass / {len(fe_fail)} fail")
print(f"preservation: {len(pr_pass)} pass / {len(pr_fail)} fail")

print("\n===== FE failures: did the answer LEAK the deleted fact? =====")
leak_kinds = Counter()
for it in fe_fail:
    a = (it.get("answer") or "").lower()
    q = it["question"].lower()
    # crude classification: answer mentions the target vs "don't know" (judge still failed it)
    if "don't have" in a or "not in" in a or "no information" in a or "doesn't" in a or "nothing about" in a:
        leak_kinds["answered-dont-know-but-judge-failed"] += 1
        tag = "DONTKNOW"
    else:
        leak_kinds["answer-mentions-content(possible leak)"] += 1
        tag = "LEAK?"
    print(f"[{tag}] inst={it['instance_id'][:15]} req={it.get('request_id')}")
    print(f"    Q: {it['question'][:85]}")
    print(f"    A: {json.dumps(it.get('answer',''))[:170]}")
    j = it.get("judge")
    if j:
        print(f"    judge: {json.dumps(j)[:150]}")

print("\nFE failure classification:", dict(leak_kinds))

print("\n===== PR failures: what got wrongly deleted? =====")
for it in pr_fail:
    print(f"inst={it['instance_id'][:15]}")
    print(f"    Q: {it['question'][:85]}")
    print(f"    A: {json.dumps(it.get('answer',''))[:170]}")
    j = it.get("judge")
    if j:
        print(f"    judge: {json.dumps(j)[:150]}")

print(f"\n===== request-level view: which forget requests cause both? =====")
by_req = {}
for it in items:
    if it.get("variant") != "forget":
        continue
    rid = it.get("request_id") or "instance-level"
    by_req.setdefault(rid, {"fe": None, "pr": [], "inst": it["instance_id"], "ftype": None})
    if it.get("suite") == "efficacy":
        by_req[rid]["fe"] = it.get("correct")
    if it.get("suite") == "preservation":
        by_req[rid]["pr"].append(it.get("correct"))
for rid, info in sorted(by_req.items()):
    pr_bad = sum(1 for c in info["pr"] if c is False)
    print(f"  {info['inst'][:14]} {rid[:16]}: FE={'ok' if info['fe'] else 'FAIL'} PR_fails={pr_bad}/{len(info['pr'])}")
