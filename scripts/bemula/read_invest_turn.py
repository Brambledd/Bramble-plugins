import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
inst = json.loads(Path(r"E:\ClowderAI\bemula-benchmark\data\f4_only\dialogues.jsonl").read_text(encoding="utf-8").splitlines()[0])
for s in inst["sessions"]:
    for t in s["turns"]:
        low = t["text"].lower()
        if t["speaker"] == "user" and any(w in low for w in ("invest", "fund", "bond", "saving", "diversif")):
            print("---", t["timestamp"])
            print(t["text"][:600])
            print()
