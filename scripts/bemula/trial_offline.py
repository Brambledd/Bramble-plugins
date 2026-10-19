"""Offline behavioral trial of the Bramble adapter on real Bemula data.

No LLM, no judge: observe the forget variant of one instance turn by turn
(forget-intent recognition falls back to the heuristic path), then probe a
few efficacy/preservation questions from the benchmark and print what the
store still knows versus what it dropped.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bemula.schemas import DialogueInstance, TestItem  # noqa: E402
from bramble_adapter import BrambleAdapter, FORGET_INTENT_RE  # noqa: E402


class OfflineLLM:
    """Stand-in that always fails, forcing the heuristic forget path."""

    name = "offline"

    def chat(self, *args, **kwargs):  # noqa: ARG002
        raise RuntimeError("offline trial: no LLM configured")


adapter = BrambleAdapter(OfflineLLM())
data = Path(os.environ.get("BEMULA_DATA_DIR", r"E:\ClowderAI\bemula-benchmark\data\quick_check"))
inst = DialogueInstance.model_validate_json(
    (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines()[0]
)
items = [TestItem.model_validate_json(l) for l in (data / "questions.jsonl").read_text(encoding="utf-8").splitlines()]
items = [i for i in items if i.instance_id == inst.instance_id]

# ---- observe the FORGET variant ----
print(f"instance {inst.instance_id}: {len(inst.sessions)} session(s)")
forget_turns = 0
for session in inst.sessions:
    for turn in session.turns:
        if turn.speaker == "user" and FORGET_INTENT_RE.search(turn.text):
            forget_turns += 1
            print(f"  [forget-request detected] {turn.text[:90]}")
        adapter.observe(turn)
print(f"forget requests detected: {forget_turns}/{len(inst.forget_requests)}")

# ---- probe every question of this instance ----
print("\nprobes:")
for item in items[:12]:
    answer = adapter.query(item.question)
    tag = f"{item.suite.value:12s}"
    print(f"  [{tag}] Q: {item.question[:70]}")
    print(f"               A: {answer[:100]}")

stats = adapter.bridge.call("stats")
print("\nstore after forget variant:", {k: stats['evidence'][k] for k in ('total', 'byKind')})
adapter.close()
