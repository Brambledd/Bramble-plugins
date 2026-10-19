import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
for line in Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_lite5f\items.jsonl").read_text(encoding="utf-8").splitlines():
    item = json.loads(line)
    if item.get("suite") == "relearning":
        print(f"[{item['instance_id']}/{item.get('variant')}] correct={item.get('correct')}")
        print("  Q:", item["question"][:90])
        print("  A:", json.dumps(item.get("answer", ""))[:260])
        j = item.get("judge")
        if j:
            print("  judge:", json.dumps(j)[:160])
        print()
