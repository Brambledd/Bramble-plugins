"""Test whether F4 RA=0 is reproducible or a one-off.

Runs the F4 instance TWICE in the same process:
1. First pass: observe all control turns, probe retention, dump store state
2. Compare: which retention probes passed/failed and WHY

Also checks: is the F4 instance's failure about the specific question
wording, or about the entire instance's memory being absent?
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

llm = get_llm(model=os.environ.get("BEMULA_AGENT_MODEL", "glm-5.3"))

data = Path(r"E:\ClowderAI\bemula-benchmark\data\f4_only")
inst = DialogueInstance.model_validate_json(
    (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()[0]
)
questions = [TestItem.model_validate_json(l) for l in (data / "questions.jsonl").read_text(encoding="utf-8").splitlines()]
retention_qs = [q for q in questions if q.suite.value == "retention"]

print(f"instance: {inst.instance_id}")
print(f"sessions: {len(inst.sessions)} | user turns: {sum(1 for s in inst.sessions for t in s.turns if t.speaker=='user')}")
print(f"retention questions: {len(retention_qs)}")
for q in retention_qs:
    print(f"  - {q.question[:90]}")
    print(f"    gold: {q.gold_answer[:90]}")

# Run TWO independent trials
for trial in (1, 2):
    print(f"\n{'='*60}")
    print(f"TRIAL {trial}")
    print("="*60)

    adapter = ba.BrambleAdapter(llm)
    adapter.reset()

    # observe all control turns
    for i, session in enumerate(inst.control_sessions):
        adapter.begin_session(session)
        for turn in session.turns:
            adapter.observe(turn)
        adapter.end_variant()

    # check store state
    stats = adapter.bridge.call("stats")
    print(f"store: total={stats['evidence']['total']} byKind={stats['evidence']['byKind']} inferences={sum(1 for r in adapter.bridge.call('list').get('items',[]) if r.get('kind')=='inference')}")

    # check: does an inference entry exist about saving/investing?
    all_items = adapter.bridge.call("list").get("items", [])
    save_items = [it for it in all_items if any(w in str(it.get("summary","")).lower() for w in ["saving","invest","fund","bond","emergency"])]
    print(f"entries mentioning saving/invest/fund/bond: {len(save_items)}")
    for it in save_items[:5]:
        print(f"  {it['anchor']}: {str(it.get('summary',''))[:80]}")

    # probe retention
    for q in retention_qs:
        answer = adapter.query(q.question)
        leaked = any(w in answer.lower() for w in q.gold_answer.lower().split()[:5] if len(w) > 3)
        print(f"\n  Q: {q.question[:70]}")
        print(f"  A: {answer[:160]}")
        print(f"  gold keywords in answer: {leaked}")

    adapter.close()

    if trial == 1:
        print("\n--- starting trial 2 with fresh adapter ---\n")

print("\n===== ANALYSIS =====")
print("If both trials fail the same way, the F4 RA=0 is structural (not random).")
print("If they differ, it's LLM stochasticity (answer generation variance).")
