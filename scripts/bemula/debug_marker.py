import json, subprocess, sys, time
sys.stdout.reconfigure(encoding="utf-8")
NODE = r"C:\Users\19356\AppData\Local\nvm\v22.14.0\node.exe"
bridge = r"E:\ClowderAI\Bramble-plugins\scripts\bemula\clowder_bridge.mjs"
proc = subprocess.Popen([NODE, bridge], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)

def call(op, **p):
    proc.stdin.write(json.dumps({"op": op, **p}) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    return json.loads(line) if line else {"DEAD": proc.stderr.read()[:500]}

call("reset")
r = call("forget", scope="facts", targets=["favorite color blue"], evidenceScope="threads")
print("forget:", json.dumps(r)[:200])
items = call("list").get("items", [])
for i in items:
    if i.get("kind") == "retraction":
        print("marker keywords raw:", repr(i["keywords"]))
proc.stdin.close()
proc.wait(timeout=5)
err = proc.stderr.read()
if err:
    print("STDERR:", err[:400])
