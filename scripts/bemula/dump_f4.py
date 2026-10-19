import json
from pathlib import Path

for line in Path(r"E:\ClowderAI\bemula-benchmark\results\bramble_f4\items.jsonl").read_text(encoding="utf-8").splitlines():
    item = json.loads(line)
    if item.get("suite") in ("retention", "efficacy"):
        print(f"[{item.get('suite')}/{item.get('variant')}] correct={item.get('correct')}")
        print("   Q:", item["question"][:85])
        print("   A:", json.dumps(item.get("answer", ""))[:260])
