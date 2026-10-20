"""Verify: P0007's PR failures come from _confirm_removals' aggressive
'until unsure REMOVE' rule on the F1 path. Replay the F1 deletion and
check what survives vs what gets taken out."""
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
    [l for l in (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines() if "profile-0007" in l][0]
)

print("forget requests:")
for r in inst.forget_requests:
    print(f"  [{r.forget_type}] {r.request_text[:100]}")

adapter.reset()
pre_count = {}
# observe WITHOUT the forget requests first — see what facts exist
for session in inst.sessions:
    adapter.begin_session(session)
    for turn in session.turns:
        if turn.speaker == "user" and ba.FORGET_INTENT_RE.search(turn.text):
            print(f"\n  SKIP forget turn: {turn.text[:60]}")
            continue
        adapter.observe(turn)
adapter.end_variant()

pre_items = adapter.bridge.call("list").get("items", [])
print(f"\nstore before any forget: {len(pre_items)} entries")
for probe in ["banks", "health condition", "medication allergy", "budget expense dining"]:
    hits = adapter.bridge.call("search", query=probe, limit=3)
    print(f"  '{probe}': {[r['summary'][:60] for r in hits.get('results', [])[:2]]}")

# now replay ONE forget request and see what the confirm stage does
req_text = inst.forget_requests[0].request_text
print(f"\n===== replaying F1: {req_text[:80]} =====")
plan = adapter._plan_forget(req_text)
print(f"plan: scope={plan['scope']} targets={plan['targets'][:3]}")

# trace the fact_removals path
removals = []
seen = set()
for target in plan["targets"]:
    probes = [target]
    import re as _re
    words = [w for w in _re.findall(r"[\w']+", target) if w.lower() not in adapter.STOPWORDS and len(w) > 2]
    if len(words) >= 2:
        probes.append(" ".join(words[:2]))
    if len(words) > 2:
        probes.append(" ".join(words[-2:]))
    for probe in probes:
        hits = adapter.bridge.call("search", query=probe, limit=8)
        for r in hits.get("results", []):
            if r["anchor"] not in seen:
                seen.add(r["anchor"])
                removals.append(r)

print(f"\ncandidates before confirm ({len(removals)}):")
for r in removals[:10]:
    print(f"  {r['anchor']}: {str(r.get('summary',''))[:70]}")

expanded = adapter._related_expansion(removals)
print(f"\nafter C2 expansion ({len(expanded)}):")
for r in expanded[len(removals):][:5]:
    print(f"  + {r['anchor']}: {str(r.get('summary',''))[:70]}")

confirmed = adapter._confirm_removals(req_text, expanded)
print(f"\nconfirmed for removal ({len(confirmed)}): {confirmed}")
adapter.close()
