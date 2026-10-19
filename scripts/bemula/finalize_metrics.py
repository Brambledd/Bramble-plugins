"""Compute metrics + report from the 4 complete instances already on disk."""
import sys
from pathlib import Path

sys.path.insert(0, r"E:\ClowderAI\bemula-benchmark")

from bemula.eval.metrics import compute_metrics  # noqa: E402
from bemula.eval.runner import ItemRecord  # noqa: E402
from bemula.schemas import load_jsonl  # noqa: E402

out = Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5c")
records = load_jsonl(out / "items.jsonl", ItemRecord)
instances = {r.instance_id for r in records}
print(f"instances on disk: {len(instances)} | items: {len(records)}")
metrics = compute_metrics(list(records))
(out / "metrics.json").write_text(
    __import__("json").dumps(metrics, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
)
print("score:", metrics["bemula_score"], "| RA:", metrics["RA"], "| FE:", metrics["FE"], "| PR:", metrics["PR"], "| RLA:", metrics["RLA"], "| AR:", metrics["AR"]["average"])
print("by_type FE:", {k: v.get("FE") for k, v in metrics.get("by_forget_type", {}).items()})

# reuse the official report writer
import importlib.util  # noqa: E402
spec = importlib.util.spec_from_file_location("run_eval_mod", r"E:\ClowderAI\bemula-benchmark\scripts\run_eval.py")
# avoid executing CLI main; just borrow write_report via exec of its source? simpler: inline minimal report below
print("\nby_forget_type detail:")
for ftype, m in metrics.get("by_forget_type", {}).items():
    print(f"  {ftype}: RA={m.get('RA')} FE={m.get('FE')} RLA={m.get('RLA')} AR={m.get('AR', {}).get('average') if isinstance(m.get('AR'), dict) else m.get('AR')}")
