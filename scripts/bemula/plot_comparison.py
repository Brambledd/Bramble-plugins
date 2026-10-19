"""Bemula score comparison chart: bramble iterations vs paper baselines.

Generates a PNG with (a) a line chart of our optimization trajectory,
(b) the paper's official 20 runs as reference lines, shared Y axis.
"""
import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

RESULTS = Path(r"E:\ClowderAI\bemula-benchmark\results")

# ---- our trajectory (lite first-5 instances, same split throughout) ----
ours = [
    ("v1\nbaseline\n(flash)", "bramble_lite5"),
    ("v3\n+consolidation", "bramble_lite5c"),
    ("v5e\n+RLA/AR opts", "bramble_lite5e"),
    ("v5g\n+lazyConsolid\n(GLM-5.3)", "bramble_lite5g_glm53"),
]
traj_labels = []
traj_scores = []
traj_gated = []
for label, run in ours:
    m = RESULTS / run / "metrics.json"
    if not m.exists():
        print(f"skip missing {run}")
        continue
    data = json.loads(m.read_text(encoding="utf-8"))
    traj_labels.append(label)
    traj_scores.append(data["bemula_score"] or 0)
    traj_gated.append((data.get("gated") or {}).get("bemula_score") or 0)

# quick_check as the mechanism-verified starting point (different split,
# shown only as an annotated marker, not part of the lite line)
qc = json.loads((RESULTS / "bramble_quick" / "metrics.json").read_text(encoding="utf-8"))

# ---- paper runs ----
paper = {}
for d in sorted(RESULTS.iterdir()):
    m = d / "metrics.json"
    if not m.exists() or d.name.startswith("bramble"):
        continue
    data = json.loads(m.read_text(encoding="utf-8"))
    paper[d.name] = data["bemula_score"] or 0

paper_sorted = sorted(paper.items(), key=lambda kv: kv[1], reverse=True)

# ---- plotting ----
fig, ax = plt.subplots(figsize=(13, 7.5), dpi=150)

# paper runs as horizontal reference lines (grouped by system for color)
systems = {}
for name, score in paper_sorted:
    sys_name = name.split("_full_")[0].split("_lite_")[0]
    systems.setdefault(sys_name, []).append((name, score))

colors = {
    "mem0": "#e74c3c",
    "amem": "#e67e22",
    "langmem": "#9b59b6",
    "lightmem": "#2980b9",
    "simplemem": "#27ae60",
    "rag": "#7f8c8d",
    "fullcontext": "#34495e",
}
for sys_name, runs in systems.items():
    for name, score in runs:
        model = name.split("_")[-1]
        ax.axhline(score, color=colors.get(sys_name, "#95a5a6"), linewidth=0.9, alpha=0.55, linestyle="--")
        ax.text(2.72, score, f"{sys_name}/{model}  {score:.3f}", fontsize=7.5, va="center", ha="left",
                color=colors.get(sys_name, "#555555"), alpha=0.9)

# our trajectory lines
x = list(range(len(traj_labels)))
ax.plot(x, traj_scores, marker="o", markersize=9, linewidth=2.6, color="#c0392b", label="Bramble (this work)", zorder=5)
ax.plot(x, traj_gated, marker="s", markersize=7, linewidth=1.8, color="#c0392b", alpha=0.55,
        linestyle=":", label="Bramble RA-gated", zorder=4)
for xi, s, g in zip(x, traj_scores, traj_gated):
    ax.annotate(f"{s:.3f}", (xi, s), textcoords="offset points", xytext=(0, 11),
                ha="center", fontsize=10, fontweight="bold", color="#c0392b")
    ax.annotate(f"{g:.3f}", (xi, g), textcoords="offset points", xytext=(0, -16),
                ha="center", fontsize=8.5, color="#8e2b20", alpha=0.8)

# quick_check marker (annotated, different split)
ax.scatter([0], [qc["bemula_score"]], marker="*", s=220, color="#f39c12", zorder=6,
           edgecolors="#b9770e", linewidths=0.8)
ax.annotate(f"quick_check (smoke split)\n{qc['bemula_score']:.3f}", (0, qc["bemula_score"]),
            textcoords="offset points", xytext=(14, 6), fontsize=8, color="#b9770e")

ax.set_xticks(x)
ax.set_xticklabels(traj_labels, fontsize=9.5)
ax.set_ylabel("Bemula Score", fontsize=12)
ax.set_xlabel("Bramble optimization iterations (Bemula lite split, first 5 instances)", fontsize=10.5)
ax.set_title("Memory Unlearning: Bramble vs. Paper Baselines (Bemula benchmark)\n"
             "dashed lines = the paper's 20 official runs (6 memory systems x 3 LLMs + full-context)",
             fontsize=12.5)
ax.set_ylim(0, 0.95)
ax.set_xlim(-0.4, 3.9)
ax.legend(loc="lower right", fontsize=10, framealpha=0.9)
ax.grid(axis="y", alpha=0.25)
fig.tight_layout()

out = Path(r"E:\ClowderAI\Bramble-plugins\scripts\bemula\score_comparison.png")
fig.savefig(out, bbox_inches="tight")
print("saved:", out)
print("\npaper best:", paper_sorted[0])
print("our final:", traj_scores[-1], "| gated:", traj_gated[-1])
