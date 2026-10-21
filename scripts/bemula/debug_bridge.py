import json, subprocess, sys
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
NODE = r"C:\Users\19356\AppData\Local\nvm\v22.14.0\node.exe"
bridge = Path(r"E:\ClowderAI\Bramble-plugins\scripts\bemula\clowder_bridge.mjs")
proc = subprocess.Popen([NODE, str(bridge)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
def call(op, **p):
    proc.stdin.write(json.dumps({"op": op, **p}) + "\n"); proc.stdin.flush()
    line = proc.stdout.readline()
    return json.loads(line) if line else {"DEAD": proc.stderr.read()[:800]}
print("reset:", call("reset"))
call("observe", speaker="user", text="My bank account password is hunter2", timestamp="2025-01-01T10:00:00Z", sessionId="s1", turnIndex=0)
print("flush:", call("flush"))
r = call("search", query="bank account password", limit=5)
print("search:", json.dumps(r)[:500])
proc.stdin.close(); proc.wait(timeout=5)
err = proc.stderr.read()
if err: print("STDERR:", err[:800])
