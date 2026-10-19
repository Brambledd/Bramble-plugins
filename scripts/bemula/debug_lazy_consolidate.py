"""Check whether lazy consolidation actually produced an inference entry
for the relearning fact, and where it ranks for the probe question."""
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

item = rl[0]
for t in item.context_turns:
    adapter.observe(t)

# manual consolidation so we can inspect the store BEFORE query does its own
print("store before query-triggered consolidation:")
pre = adapter.bridge.call("list").get("items", [])
print("  total:", len(pre), "| inference:", sum(1 for r in pre if r.get("kind") == "inference"))

# call query (triggers lazy consolidation inside)
answer = adapter.query(item.question)

post = adapter.bridge.call("list").get("items", [])
print("store after query:")
print("  total:", len(post), "| inference:", sum(1 for r in post if r.get("kind") == "inference"))
new_inferences = [r for r in post if r not in pre]
print("  NEW entries during query:")
for r in new_inferences:
    print(f"    {r['anchor']} [{r.get('kind')}]: {str(r.get('summary'))[:100]}")

hits = adapter.bridge.call("search", query=item.question, limit=10)
print("\nretrieval after query (should include any new inference):")
for rank, r in enumerate(hits.get("results", []), 1):
    print(f"  {rank}. {r['anchor']}: {str(r['summary'])[:80]}")
print("\nanswer:", answer[:200])
adapter.close()
