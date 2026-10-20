"""Directly verify the enumerate-then-remove path on P15's forget variant
(the earlier script only dumped the plan; this one runs the FULL forget
handling and then probes the leaked questions)."""
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
for session in inst.sessions:  # the FORGET variant: includes the request
    adapter.begin_session(session)
    for turn in session.turns:
        adapter.observe(turn)
adapter.end_variant()

stats = adapter.bridge.call("stats")
print("store after forget variant:", stats["evidence"]["total"], "entries")
print("topic facts cached:", len(getattr(adapter, "_last_topic_facts", []) or []))

for q in [
    "Which library book group am I part of?",
    "What do I have scheduled after running my Saturday errands?",
    "How can I keep in contact with my former nursing colleagues?",
]:
    a = adapter.query(q)
    print(f"\nQ: {q}\nA: {a[:160]}")
adapter.close()
