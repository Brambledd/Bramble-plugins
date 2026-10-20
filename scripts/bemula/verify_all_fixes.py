"""Verify three things before implementing fixes:
1. RLA fresh-write guard works (P0006 career relearning survives topic deletion)
2. P0007 F3 career enumeration — what does it actually enumerate (over-inclusive?)
3. P0015 F3 social enumeration — what entries does it point at (for PR entry-ref design)
"""
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
from bemula.schemas import DialogueInstance  # noqa: E402
import bramble_adapter as ba  # noqa: E402

llm = get_llm(model=os.environ.get("BEMULA_AGENT_MODEL", "glm-5.3"))
adapter = ba.BrambleAdapter(llm)

data = Path(r"E:\ClowderAI\bemula-benchmark\data\lite")
all_insts = {}
for line in (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()[:5]:
    inst = DialogueInstance.model_validate_json(line)
    all_insts[inst.instance_id] = inst

# ---- TEST 1: RLA fresh-write guard on P0006 ----
print("===== TEST 1: P0006 RLA (career topic + relearning) =====")
inst = all_insts["profile-0006:inst0"]
adapter.reset()
for session in inst.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()

# simulate relearning: observe the new career fact AFTER deletion
new_fact = "Work has taken a different direction lately. I'm a product manager at a renewable energy startup."
adapter.observe(type("T", (), {"speaker": "user", "text": new_fact, "timestamp": "",
                               "linked_fact_ids": []})())
answer = adapter.query("What job and kind of company did I say I work for?")
ok1 = "product manager" in answer.lower() and "renewable" in answer.lower()
print(f"  relearning survives: {ok1}")
print(f"  answer: {answer[:120]}")

# ---- TEST 2: P0007 F3 career enumeration output ----
print("\n===== TEST 2: P0007 career enumeration =====")
inst7 = all_insts["profile-0007:inst0"]
adapter.reset()
for session in inst7.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()

items = adapter.bridge.call("list").get("items", [])
for r in inst7.forget_requests:
    print(f"  req type={r.forget_type} targets={len(r.target_fact_ids)}: {r.request_text[:60]}")
career_req = max(inst7.forget_requests, key=lambda r: len(r.target_fact_ids)).request_text
print(f"  request: {career_req[:100]}")
facts = adapter._enumerate_topic_facts(career_req, items)
print(f"  enumerated {len(facts)} facts:")
for f in facts:
    print(f"    - {f[:90]}")

# which of these match the PR-lost facts?
print("\n  PR-vulnerable facts that got enumerated:")
for f in facts:
    for kw in ["bank", "health", "condition", "medication", "allergy"]:
        if kw in f.lower():
            print(f"    !! OVER-INCLUSIVE: {f[:80]}")

# ---- TEST 3: P0015 social enumeration ----
print("\n===== TEST 3: P0015 social enumeration =====")
inst15 = all_insts["profile-0015:inst0"]
adapter.reset()
for session in inst15.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()

items15 = adapter.bridge.call("list").get("items", [])
social_req = max(inst15.forget_requests, key=lambda r: len(r.target_fact_ids)).request_text
facts15 = adapter._enumerate_topic_facts(social_req, items15)
print(f"  enumerated {len(facts15)} facts:")
for f in facts15:
    print(f"    - {f[:90]}")

adapter.close()
