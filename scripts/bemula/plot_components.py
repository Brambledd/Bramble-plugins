"""Component-wise comparison: bramble final (v5g) vs paper's 20 runs.

Grouped bars for the four Bemula Score components (FE, AR, PR, RLA) plus
the composite score — our final version against every paper run.
"""
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

RESULTS = Path(r"E:\ClowderAI\bemula-benchmark\results")


def load(run: str) -> dict:
    return json.loads((RESULTS / run / "metrics.json").read_text(encoding="utf-8"))


ours = load("bramble_lite5g_glm53")

paper_runs = []
for d in sorted(RESULTS.iterdir()):
    m = d / "metrics.json"
    if not m.exists() or d.name.startswith("bramble"):
        continue
    data = json.loads(m.read_text(encoding="utf-8"))
    ar = (data.get("AR") or {}).get("average")
    paper_runs.append({
        "label": d.name.replace("_full_", "/").replace("_lite_", "/lite/"),
        "FE": data.get("FE"),
        "AR": ar,
        "PR": data.get("PR"),
        "RLA": data.get("RLA"),
        "Score": data.get("bemula_score"),
    })

# order paper runs by composite score
paper_runs.sort(key=lambda r: r["Score"] or 0)

# all bars: paper runs (sorted) + ours at the end, highlighted
all_runs = paper_runs + [
    {"label": "BRAMBLE\n(this work)", "FE": ours.get("FE"), "AR": (ours.get("AR") or {}).get("average"),
     "PR": ours.get("PR"), "RLA": ours.get("RLA"), "Score": ours.get("bemula_score")},
]

components = ["FE", "AR", "PR", "RLA", "Score"]
comp_colors = {"FE": "#c0392b", "AR": "#e67e22", "PR": "#2980b9", "RLA": "#27ae60", "Score": "#8e44ad"}

fig, ax = plt.subplots(figsize=(16, 8), dpi=150)
n = len(all_runs)
width = 0.16
xs = np.arange(n)

for i, comp in enumerate(components):
    vals = [r[comp] if r[comp] is not None else 0 for r in all_runs]
    offset = (i - 2) * width
    bars = ax.bar(xs + offset, vals, width * 0.92, label=comp, color=comp_colors[comp],
                  alpha=0.9 if comp != "Score" else 1.0,
                  edgecolor="#2c3e50" if comp == "Score" else "none", linewidth=0.6 if comp == "Score" else 0)
    # value labels only on our bar to avoid clutter
    ours_idx = n - 1
    ax.text(ours_idx + offset, vals[ours_idx] + 0.015, f"{vals[ours_idx]:.2f}",
            ha="center", fontsize=9, fontweight="bold", color=comp_colors[comp])

ax.set_xticks(xs)
ax.set_xticklabels([r["label"].replace("/", "\n", 1) for r in all_runs], fontsize=8, rotation=38, ha="right")
ax.set_ylabel("Score (0-1)", fontsize=12)
ax.set_title("Bemula Components — Bramble (final) vs Paper's 20 Official Runs\n"
             "Score = √(FE×AR) × √(PR×RLA)", fontsize=13)
ax.set_ylim(0, 1.02)
ax.legend(fontsize=11, loc="upper left", title="Component", title_fontsize=11)
ax.grid(axis="y", alpha=0.25)

# highlight our bar group
ax.axvspan(n - 1 - 0.45, n - 1 + 0.45, color="#f39c12", alpha=0.12, zorder=0)
ax.text(n - 1, 0.97, "0.313\n(#1 of 21)", ha="center", fontsize=11, fontweight="bold", color="#b9770e")

fig.tight_layout()
out = Path(r"E:\ClowderAI\Bramble-plugins\scripts\bemula\component_comparison.png")
fig.savefig(out, bbox_inches="tight")
print("saved:", out)
print("\nBramble final components:")
for comp in components:
    print(f"  {comp}: {[r[comp] for r in all_runs if 'BRAMBLE' in r['label']][0]}")
print("\npaper runs charted:", len(paper_runs))
