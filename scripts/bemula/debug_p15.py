"""Did profile-0015's topic deletion actually change at all? Replay its
F3 request with the new plan and dump the fact list the LLM produced."""
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
inst = DialogueInstance.model_validate_json(
    [l for l in (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines() if "profile-0015" in l][0]
)
adapter.reset()
for session in inst.control_sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()

# replay the forget variant up to the request, then dump the plan
forget_text = None
for session in inst.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
        if turn.speaker == "user" and ba.FORGET_INTENT_RE.search(turn.text):
            forget_text = turn.text
adapter.end_variant()

print("forget request:", forget_text[:120])
plan = adapter._plan_forget(forget_text)
print("scope:", plan.get("scope"))
print("targets:", plan.get("targets"))
print("fact list (%d):" % len(plan.get("facts") or []))
for f in plan.get("facts") or []:
    print("  -", f[:100])

# what's still in the store matching the leaked facts?
for probe in ["library book group", "Priya coffee", "WhatsApp nursing colleagues"]:
    hits = adapter.bridge.call("search", query=probe, limit=3)
    print(f"\nsearch '{probe}':", [(r["anchor"], str(r["summary"])[:60]) for r in hits.get("results", [])])
adapter.close()
