"""Deep RLA replay for profile-0006: dump the relearning context turns, the
retrieval, and where the new fact sits in the ranking."""
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
iid = "profile-0006:inst0"
inst = all_insts[iid]
rl = [i for i in all_items if i.instance_id == iid and i.suite.value == "relearning"]

adapter = BrambleAdapter(llm)
adapter.reset()
for session in inst.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()

for item in rl:
    print("=" * 70)
    print("Q:", item.question)
    print("gold:", item.gold_answer[:120])
    print("context_turns:")
    for t in item.context_turns:
        print(f"  + [{t.timestamp}] {t.text[:150]}")
    for t in item.context_turns:
        adapter.observe(t)
    hits = adapter.bridge.call("search", query=item.question, limit=10)
    print("  retrieval after observing:")
    found_rank = None
    for rank, r in enumerate(hits.get("results", []), 1):
        is_new = any(t.text[:40] in str(r.get("summary", "")) for t in item.context_turns)
        if is_new:
            found_rank = rank
        print(f"    {rank}. {r['anchor']}: {str(r['summary'])[:70]}{' <== NEW FACT' if is_new else ''}")
    print(f"  new fact rank: {found_rank}")
    answer = adapter.query(item.question)
    print("  answer:", answer[:220])
adapter.close()
