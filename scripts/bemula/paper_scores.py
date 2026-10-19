"""Dump the paper's own baseline scores (their official runs) for comparison."""
import json
from pathlib import Path

results = Path(r"E:\ClowderAI\bemula-benchmark\results")
rows = []
for d in sorted(results.iterdir()):
    m = d / "metrics.json"
    if not m.exists() or d.name.startswith("bramble"):
        continue
    try:
        data = json.loads(m.read_text(encoding="utf-8"))
    except Exception:
        continue
    rows.append({
        "run": d.name,
        "instances": data.get("num_instances"),
        "items": data.get("num_items"),
        "RA": data.get("RA"),
        "FE": data.get("FE"),
        "PR": data.get("PR"),
        "RLA": data.get("RLA"),
        "AR": (data.get("AR") or {}).get("average") if isinstance(data.get("AR"), dict) else data.get("AR"),
        "FA": data.get("FA"),
        "UG": data.get("UG"),
        "score": data.get("bemula_score"),
        "inst_pass": data.get("instance_pass_rate"),
        "rpr": data.get("request_pass_rate"),
    })

print(f"{'run':38s} {'inst':>5s} {'RA':>6s} {'FE':>6s} {'PR':>6s} {'RLA':>6s} {'AR':>6s} {'FA':>6s} {'UG':>6s} {'SCORE':>7s} {'instP':>6s} {'RPR':>6s}")
for r in rows:
    def fmt(v, w=6):
        return f"{v:.3f}" if isinstance(v, (int, float)) else "  -- "
    print(f"{r['run']:38s} {str(r['instances']):>5s} {fmt(r['RA'])} {fmt(r['FE'])} {fmt(r['PR'])} {fmt(r['RLA'])} {fmt(r['AR'])} {fmt(r['FA'])} {fmt(r['UG'])} {fmt(r['score'],7)} {fmt(r['inst_pass'])} {fmt(r['rpr'])}")
