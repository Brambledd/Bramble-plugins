"""Clean F4 end-to-end test with proper test corpus.

Phase 1: Observe the F4 instance's dialogue turns (control + forget variant)
Phase 2: Execute the forget request
Phase 3: Verify deletion (FE) and preservation (PR) via search
Phase 4: Verify relearning (RLA) via new fact observation
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
adapter = ba.BrambleAdapter(llm)

data = Path(r"E:\ClowderAI\bemula-benchmark\data\f4_only")
inst = DialogueInstance.model_validate_json(
    (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()[0]
)
questions = [TestItem.model_validate_json(l) for l in (data / "questions.jsonl").read_text(encoding="utf-8").splitlines()]

print(f"instance: {inst.instance_id} | sessions: {len(inst.sessions)} | user turns: {sum(1 for s in inst.sessions for t in s.turns if t.speaker=='user')}")

# Phase 1: control variant (observe everything, no forget)
adapter.reset()
for session in inst.control_sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
    adapter.end_variant()

retention_probe = next(q for q in questions if q.suite.value == "retention")
answer = adapter.query(retention_probe.question)
ra_pass = any(w in answer.lower() for w in retention_probe.gold_answer.lower().split()[:4] if len(w) > 3)
print(f"\nPhase 1 (control): RA {'PASS' if ra_pass else 'FAIL'}")
print(f"  Q: {retention_probe.question[:80]}")
print(f"  A: {answer[:160]}")

# Phase 2: reset and observe forget variant (with the forget request turn)
adapter.reset()
for session in inst.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        if ba.FORGET_INTENT_RE.search(turn.text):
            print(f"\n  [forget request detected] {turn.text[:80]}")
            continue  # skip the request turn itself
        adapter.observe(turn)
    adapter.end_variant()

# Phase 3: forget variant — process the forget request
print("\n--- executing forget request ---")
forget_req = next(r for r in inst.forget_requests)
print(f"  request: {forget_req.request_text[:100]}")
plan = adapter._plan_forget(forget_req.request_text)
print(f"  plan scope: {plan.get('scope')} | targets: {plan.get('targets', [])[:3]}")
entries = adapter._enumerate_topic_facts(forget_req.request_text, adapter.bridge.call("list").get("items", []))
print(f"  enumerated {len(entries)} entries for removal:")
for e in entries[:5]:
    print(f"    - {e['anchor']}: {str(e.get('summary',''))[:70]}")
if entries:
    anchors_to_remove = [e["anchor"] for e in entries]
    adapter._remove_with_guard(anchors_to_remove)
    print(f"  removed {len(anchors_to_remove)} entries")
else:
    print("  WARNING: no entries to remove!")

# Phase 4: query after forget — the answer should NOT mention the forgotten content
efficacy_probe = next(q for q in questions if q.suite.value == "efficacy")
answer = adapter.query(efficacy_probe.question)
leaked = any(w in answer.lower() for w in efficacy_probe.gold_answer.lower().split()[:4] if len(w) > 3)
print(f"\nPhase 3 (efficacy after forget): {'LEAK' if leaked else 'CLEAN'}")
print(f"  Q: {efficacy_probe.question[:80]}")
print(f"  A: {answer[:160]}")

# Phase 5: preservation — unrelated facts should still be answerable
pres_items = [q for q in questions if q.suite.value == "preservation"]
pr_pass = 0
for p in pres_items[:3]:
    a = adapter.query(p.question)
    has_info = "don't have" not in a.lower() and "no information" not in a.lower()
    pr_pass += 1 if has_info else 0
    print(f"\n  preservation Q: {p.question[:60]}")
    print(f"  has info: {has_info}")
print(f"preservation: {pr_pass}/{min(3, len(pres_items))} answerable")

# Phase 6: relearning — observe a new fact about the forgotten topic
print("\n--- relearning test ---")
new_turn = type("T", (), {"speaker": "user",
    "text": "I've decided to invest in a mix of index funds and corporate bonds for my long-term portfolio.",
    "timestamp": "2026-10-20T12:00:00Z", "linked_fact_ids": []})()
adapter.observe(new_turn)
answer = adapter.query("What is my current approach to saving and investing?")
rla_ok = "index fund" in answer.lower() or "bond" in answer.lower() or "portfolio" in answer.lower()
print(f"  relearning answer: {answer[:180]}")
print(f"  relearning detected new info: {rla_ok}")

adapter.close()
print("\n===== DONE =====")
