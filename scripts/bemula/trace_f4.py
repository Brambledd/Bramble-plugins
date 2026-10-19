"""Trace the F4 instance end to end: full observe -> consolidation ->
check inference entries -> probe retention question."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(r"E:\ClowderAI\bemula-benchmark\.env", override=True)
import os  # noqa: E402

os.environ.setdefault("NO_PROXY", "open.bigmodel.cn,localhost,127.0.0.1")
os.environ.setdefault("no_proxy", "open.bigmodel.cn,localhost,127.0.0.1")

from bemula.llm import get_llm  # noqa: E402
from bemula.schemas import DialogueInstance  # noqa: E402
import bramble_adapter as ba  # noqa: E402
from bramble_adapter import FORGET_INTENT_RE  # noqa: E402

llm = get_llm(model=os.environ.get("BEMULA_AGENT_MODEL", "glm-5.3-flash"))
adapter = ba.BrambleAdapter(llm)

data = Path(r"E:\ClowderAI\bemula-benchmark\data\f4_only")
inst = DialogueInstance.model_validate_json(
    (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()[0]
)
print(f"{inst.instance_id}: {len(inst.sessions)} sessions, "
      f"{sum(1 for s in inst.sessions for t in s.turns if t.speaker=='user')} user turns")

# control variant: observe everything (no forget handling needed but keep it
# faithful — control_sessions contain no forget requests)
adapter.reset()
for i, session in enumerate(inst.control_sessions):
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()

items = adapter.bridge.call("list").get("items", [])
inferences = [it for it in items if it.get("kind") == "inference"]
print(f"\nafter consolidation: total={len(items)} inferences={len(inferences)}")
for it in inferences[:6]:
    print(f"  INF: {str(it.get('summary'))[:100]}")

hits = adapter.bridge.call("search", query="What approach do I take to saving and investing", limit=10)
print("\nretention probe hits:")
for r in hits.get("results", []):
    print(f"  {r['anchor']}: {str(r['summary'])[:90]}")
answer = adapter.query("What approach do I take to saving and investing?")
print("\nanswer:", answer[:300])
adapter.close()
