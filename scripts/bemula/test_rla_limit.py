"""Simulate the effect of expanding the relearning probe's search limit
from the current top_k=10 to 15 and 20 — measure whether the missed
relearning facts enter the candidate set at higher limits.

Uses the actual lite5f failure data (profile-0011) to test with real content.
"""
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
import bramble_adapter as ba  # noqa: E402

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

# the instance that had RLA failures
iid = "profile-0011:inst0"
inst = all_insts[iid]
rl_items = [i for i in all_items if i.instance_id == iid and i.suite.value == "relearning"]

adapter = ba.BrambleAdapter(llm)
adapter.reset()
for session in inst.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()

for item in rl_items:
    print(f"Q: {item.question[:80]}")
    print(f"gold: {item.gold_answer[:80]}")
    for t in item.context_turns:
        print(f"  + observe: {t.text[:80]}")
        adapter.observe(t)

    # test different search limits
    for limit in (5, 10, 15, 20):
        hits = adapter.bridge.call("search", query=item.question, limit=limit)
        results = hits.get("results", [])
        # check if the new fact's turn appears in the results
        new_turn_found = any(
            any(kw in str(r.get("summary", "")).lower() for kw in item.gold_answer.lower().split()[:3] if len(kw) > 3)
            for r in results
        )
        # also check anchors that shouldn't be there (old deleted entries)
        print(f"  limit={limit}: {len(results)} results, new-fact-relevant={'YES' if new_turn_found else 'no'}")

    # also test with the context turn text as the query directly
    ctx_text = item.context_turns[0]["text"] if item.context_turns else ""
    if ctx_text:
        hits_direct = adapter.bridge.call("search", query=ctx_text[:80], limit=5)
        print(f"  direct context-text search: {len(hits_direct.get('results', []))} results")

    print()

adapter.close()
