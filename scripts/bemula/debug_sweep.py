import json, subprocess, sys, os
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
NODE = r"C:\Users\19356\AppData\Local\nvm\v22.14.0\node.exe"
bridge = Path(r"E:\ClowderAI\Bramble-plugins\scripts\bemula\clowder_bridge.mjs")
proc = subprocess.Popen([NODE, str(bridge)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
def call(op, **p):
    proc.stdin.write(json.dumps({"op": op, **p}) + "\n"); proc.stdin.flush()
    line = proc.stdout.readline()
    return json.loads(line) if line else {"DEAD": proc.stderr.read()[:600]}

call("reset")
call("observe", speaker="user", text="Doctor says my asthma is mild, use the inhaler daily",
     timestamp="2025-02-01T10:00:00Z", sessionId="s2", turnIndex=0)
call("put", anchor="infer-test", text="For health, the user manages asthma with an inhaler.", keywords=["health","asthma"])
r = call("search", query="asthma inhaler", limit=10)
print("BEFORE:", [(h["anchor"], h["summary"][:50]) for h in r["results"]])
r = call("forget", scope="facts", targets=["asthma inhaler health"], evidenceScope="threads")
print("FORGET:", json.dumps(r)[:400])
r = call("search", query="asthma inhaler", limit=10)
print("AFTER:", [(h["anchor"], h["summary"][:50]) for h in r.get("results", [])])
r = call("list")
print("LIST:", [(i["anchor"], (i["summary"] or "")[:40]) for i in r.get("items", [])])
proc.stdin.close(); proc.wait(timeout=5)
err = proc.stderr.read()
if err: print("STDERR:", err[:400])
