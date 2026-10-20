"""Final pre-run verification: all three fix areas on the actual instances."""
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

results = {}

# ---- V1: P0015 FE (social deletion completeness) ----
print("===== V1: P0015 FE =====")
inst = all_insts["profile-0015:inst0"]
adapter.reset()
for session in inst.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()
fe_probes = [
    ("Which library book group am I part of?", "book group"),
    ("What do I have scheduled after running my Saturday errands?", "Priya"),
    ("How can I keep in contact with my former nursing colleagues?", "WhatsApp"),
]
fe_ok = 0
for q, leak_kw in fe_probes:
    a = adapter.query(q)
    leaked = leak_kw.lower() in a.lower()
    fe_ok += 0 if leaked else 1
    print(f"  {'PASS' if not leaked else 'LEAK'}: {q[:50]} -> {leak_kw} {'IN' if leaked else 'NOT IN'} answer")
results["P0015_FE"] = f"{fe_ok}/{len(fe_probes)}"

# ---- V2: P0007 PR (banking/health preserved through F1 grocery deletion) ----
print("\n===== V2: P0007 PR =====")
inst7 = all_insts["profile-0007:inst0"]
adapter.reset()
for session in inst7.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()
pr_probes = [
    ("Which banks do I hold accounts with?", ["bank", "TD", "RBC", "Scotiabank"]),
    ("Which health condition and treatment are recorded for me?", ["condition", "hypertension", "treatment", "medication"]),
]
pr_ok = 0
for q, gold_kws in pr_probes:
    a = adapter.query(q)
    has_content = any(kw.lower() in a.lower() for kw in gold_kws)
    pr_ok += 1 if has_content else 0
    print(f"  {'PASS' if has_content else 'LOST'}: {q[:50]} -> contains gold kw: {has_content}")
results["P0007_PR"] = f"{pr_ok}/{len(pr_probes)}"

# ---- V3: P0006 RLA (career relearning survives F3 topic deletion) ----
print("\n===== V3: P0006 RLA =====")
inst6 = all_insts["profile-0006:inst0"]
adapter.reset()
for session in inst6.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()
adapter.observe(type("T", (), {"speaker": "user",
    "text": "Work has taken a different direction lately. I'm a product manager at a renewable energy startup.",
    "timestamp": "", "linked_fact_ids": []})())
a = adapter.query("What job and kind of company did I say I work for?")
rla_ok = "product manager" in a.lower() and "renewable" in a.lower()
print(f"  {'PASS' if rla_ok else 'FAIL'}: relearning answer: {a[:100]}")
results["P0006_RLA"] = "PASS" if rla_ok else "FAIL"

print("\n===== SUMMARY =====")
for k, v in results.items():
    print(f"  {k}: {v}")
adapter.close()
