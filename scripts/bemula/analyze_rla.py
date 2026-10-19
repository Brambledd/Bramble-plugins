"""Engineering root-cause analysis for RLA (relearning) failures."""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"E:\ClowderAI\bemula-benchmark")
sys.path.insert(0, r"E:\ClowderAI\Bramble-plugins\scripts\bemula")

from dotenv import load_dotenv  # noqa: E402

load_dotenv(r"E:\ClowderAI\bemula-benchmark\.env", override=True)
import os  # noqa: E402

os.environ.setdefault("NO_PROXY", "open.bigmodel.cn,localhost,127.0.0.1")
os.environ.setdefault("no_proxy", "open.bigmodel.cn,localhost,127.0.0.1")

from bemula.llm import get_llm  # noqa: E402
from bemula.schemas import DialogueInstance, TestItem  # noqa: E402
from bramble_adapter import BrambleAdapter  # noqa: E402

data = Path(r"E:\ClowderAI\bemula-benchmark\data\lite")
all_insts = {}
for line in (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()[:5]:
    inst = DialogueInstance.model_validate_json(line)
    all_insts[inst.instance_id] = inst
all_items = []
for line in (data / "questions.jsonl").read_text(encoding="utf-8").splitlines():
    item = TestItem.model_validate_json(line)
    if item.instance_id in all_insts:
        all_items.append(item)

llm = get_llm(model=os.environ.get("BEMULA_AGENT_MODEL", "glm-5.3-flash"))

# find the instance whose relearning items FAILED in lite5f
failures = {}
for line in Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5f\items.jsonl").read_text(encoding="utf-8").splitlines():
    item = json.loads(line)
    if item.get("suite") == "relearning" and not item.get("correct"):
        failures.setdefault(item["instance_id"], []).append(item)
print("relearning failures in lite5f:", {k: len(v) for k, v in failures.items()})

iid = sorted(failures)[0]
inst = all_insts[iid]
items = failures[iid]
print(f"replaying {iid}: {len(inst.sessions)} sessions")

adapter = BrambleAdapter(llm)
adapter.reset()
for session in inst.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()

for item in items:
    print(f"\n===== Q: {item['question'][:90]}")
    print(f"    gold: {item.get('gold_answer', '')[:100]}")
    # observe the relearning context turns exactly as the evaluator does
    for t in item.get("context_turns", []):
        print(f"    observe(+): {t['text'][:90]}")
        adapter.observe(type("T", (), {"speaker": t["speaker"], "text": t["text"],
                                       "timestamp": t.get("timestamp", ""),
                                       "linked_fact_ids": t.get("linked_fact_ids", [])})())
    answer = adapter.query(item["question"])
    print(f"    A: {answer[:200]}")
    hits = adapter.bridge.call("search", query=item["question"], limit=10)
    print("    retrieval top10:")
    for r in hits.get("results", []):
        marker = " <== NEW?" if any(w in str(r.get("summary", "")).lower() for w in item.get("gold_answer", "").lower().split()[:3]) else ""
        print(f"      {r['anchor']}: {str(r['summary'])[:80]}{marker}")

print("\nfinal store:", {k: adapter.bridge.call('stats')['evidence'][k] for k in ('total', 'byKind')})
adapter.close()
