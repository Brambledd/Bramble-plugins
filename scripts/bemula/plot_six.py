"""Six-metric comparison chart: bramble latest + 4 strongest paper baselines.
Components: RA, FE, AR, PR, RLA, Score — one group per metric, one bar per system."""
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

RESULTS = Path(r"E:\ClowderAI\bemula-benchmark\results")

ours = json.loads((RESULTS / "bramble_lite5l" / "metrics.json").read_text(encoding="utf-8"))

runs = {}
for d in sorted(RESULTS.iterdir()):
    m = d / "metrics.json"
    if not m.exists() or d.name.startswith("bramble"):
        continue
    data = json.loads(m.read_text(encoding="utf-8"))
    sys_name = d.name.split("_full_")[0].split("_lite_")[0]
    score = data.get("bemula_score") or 0
    if sys_name not in runs or score > runs[sys_name]["Score"]:
        runs[sys_name] = {
            "label": f"{sys_name}\n({d.name.split('_')[-1]})",
            "RA": data.get("RA") or 0,
            "FE": data.get("FE") or 0,
            "AR": (data.get("AR") or {}).get("average") or 0,
            "PR": data.get("PR") or 0,
            "RLA": data.get("RLA") or 0,
            "Score": score,
        }

top4 = sorted(runs.items(), key=lambda kv: kv[1]["Score"], reverse=True)[:4]
selected = [v for _, v in top4]
selected.append({
    "label": "BRAMBLE\n(this work)",
    "RA": ours.get("RA") or 0,
    "FE": ours.get("FE") or 0,
    "AR": (ours.get("AR") or {}).get("average") or 0,
    "PR": ours.get("PR") or 0,
    "RLA": ours.get("RLA") or 0,
    "Score": ours.get("bemula_score") or 0,
})

components = ["RA", "FE", "AR", "PR", "RLA", "Score"]
comp_titles = {
    "RA": "RA\nRetention",
    "FE": "FE\nForgetting\nEfficacy",
    "AR": "AR\nAttack\nResistance",
    "PR": "PR\nPreservation",
    "RLA": "RLA\nReLearning",
    "Score": "Bemula\nScore",
}
sys_colors = ["#2980b9", "#27ae60", "#9b59b6", "#e67e22", "#c0392b"]

fig, ax = plt.subplots(figsize=(15, 7.5), dpi=150)
n_sys = len(selected)
xs = np.arange(len(components))
width = 0.15

for i, run in enumerate(selected):
    vals = [run[c] for c in components]
    offset = (i - (n_sys - 1) / 2) * width
    is_ours = "BRAMBLE" in run["label"]
    ax.bar(xs + offset, vals, width * 0.9, color=sys_colors[i],
           label=run["label"].replace("\n", " "),
           alpha=1.0 if is_ours else 0.82,
           edgecolor="#2c3e50" if is_ours else "none", linewidth=1.2 if is_ours else 0)
    for x, v in zip(xs + offset, vals):
        ax.text(x, v + 0.012, f"{v:.3f}", ha="center", fontsize=8,
                fontweight="bold" if is_ours else "normal",
                color="#7b241c" if is_ours else "#555555")

ax.set_xticks(xs)
ax.set_xticklabels([comp_titles[c] for c in components], fontsize=11)
ax.set_ylabel("Score (0-1)", fontsize=12)
ax.set_title("Bemula Six Metrics — Bramble vs the 4 Strongest Paper Baselines\n"
             "(Score = √(FE×AR) × √(PR×RLA); RA gates the score)", fontsize=13)
ax.set_ylim(0, 1.05)
ax.legend(fontsize=10, loc="upper right")
ax.grid(axis="y", alpha=0.25)
fig.tight_layout()

out = Path(r"E:\ClowderAI\Bramble-plugins\scripts\bemula\component_six.png")
fig.savefig(out, bbox_inches="tight")
print("saved:", out)
print("bramble:", {c: selected[-1][c] for c in components})
for name, run in top4:
    print(f"  {name}: {run['Score']:.3f}")
