"""Build a mini split containing only the F4 instance (profile-0010:inst0)."""
import json
from pathlib import Path

data = Path(r"E:\ClowderAI\bemula-benchmark\data\lite")
out = Path(r"E:\ClowderAI\bemula-benchmark\data\f4_only")
out.mkdir(exist_ok=True)

target = "profile-0010:inst0"
dialogues = [l for l in (data / "dialogues.jsonl").read_text(encoding="utf-8").splitlines() if json.loads(l)["instance_id"] == target]
(out / "dialogues.jsonl").write_text("\n".join(dialogues) + "\n", encoding="utf-8")
questions = [l for l in (data / "questions.jsonl").read_text(encoding="utf-8").splitlines() if json.loads(l)["instance_id"] == target]
(out / "questions.jsonl").write_text("\n".join(questions) + "\n", encoding="utf-8")
print(f"f4_only: {len(dialogues)} dialogue, {len(questions)} questions")
