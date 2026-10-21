"""Smoke test: clowder_bridge.mjs protocol + forget pipeline, no LLM."""
import json
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

# Node 22 for better-sqlite3 prebuilt (no PATH mutation).
import os
NODE = os.environ.get("CLOWDER_NODE") or r"C:\Users\19356\AppData\Local\nvm\v22.14.0\node.exe"
if not Path(NODE).exists():
    NODE = "node"

bridge = Path(r"E:\ClowderAI\Bramble-plugins\scripts\bemula\clowder_bridge.mjs")
proc = subprocess.Popen(
    [NODE, str(bridge)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
)

def call(op, **payload):
    proc.stdin.write(json.dumps({"op": op, **payload}) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    if not line:
        err = proc.stderr.read()
        raise RuntimeError(f"bridge died: {err[:500]}")
    return json.loads(line)

# 1. reset
r = call("reset")
assert r.get("ok"), r
print("1. reset ok")

# 2. observe a few turns in one thread
call("observe", speaker="user", text="My bank account password is hunter2 and my favorite color is blue",
     timestamp="2025-01-01T10:00:00Z", sessionId="s1", turnIndex=0)
call("observe", speaker="assistant", text="Noted, I will remember that.",
     timestamp="2025-01-01T10:00:30Z", sessionId="s1", turnIndex=1)
call("observe", speaker="user", text="Lets plan lunch tomorrow at the new Thai place",
     timestamp="2025-01-01T11:00:00Z", sessionId="s1", turnIndex=2)
print("2. observed 3 turns")

# 3. search should find passages (lazy flush)
r = call("search", query="bank account password", limit=5)
print(f"3. search: {len(r.get('results', []))} results")
for hit in r.get("results", [])[:3]:
    print(f"   {hit['anchor']}: {hit['summary'][:60]}")
assert any("hunter2" in (h.get("summary") or "") for h in r["results"]), "password passage must be findable"

# 4. forget the bank password (message-level)
r = call("forget", scope="facts", targets=["bank account password hunter2"], evidenceScope="threads")
print(f"4. forget: removed={r.get('removed')} protected={r.get('protected')} remaining={r.get('remaining')}")
for d in r.get("details", [])[:5]:
    print(f"   removed {d['anchor']}")
assert r.get("removed", 0) >= 1, "must remove at least the password message"

# 5. re-search: password gone, lunch survives
r = call("search", query="bank account password", limit=5)
assert not any("hunter2" in (h.get("summary") or "") for h in r.get("results", [])), "password must be gone"
r = call("search", query="lunch Thai", limit=5)
assert any("Thai" in (h.get("summary") or "") for h in r.get("results", [])), "lunch message must survive"
print("5. post-forget verification: password gone, lunch survives ✓")

# 6. F6 replacement
r = call("forget", scope="facts", targets=["favorite color blue"], replacement="favorite color is green now", evidenceScope="threads")
assert r.get("replacementWritten"), r
r = call("search", query="favorite color green", limit=5)
assert any("green" in (h.get("summary") or "") for h in r.get("results", [])), "replacement must be findable"
print("6. F6 replacement: old forgotten, new findable ✓")

# 7. anti-resurrection: force a full thread reindex, password stays gone
r = call("flush")
r = call("search", query="hunter2", limit=5)
assert not any("hunter2" in (h.get("summary") or "") for h in r.get("results", [])), "must not resurrect after reindex"
r = call("search", query="bank account password", limit=5)
assert not any("hunter2" in (h.get("summary") or "") for h in r.get("results", [])), "no resurrection via phrase"
print("7. anti-resurrection after forced reindex ✓")

# 7b. KNOWN BOUNDARY (documented, not asserted): message-level forget does
# NOT sweep doc-level derived entries (consolidated inferences / session
# summaries written before the forget). An attempt to add that sweep
# regressed the benchmark (clowder_lite5b: FE/AR collapsed) because fuzzy
# probe matching over-deleted; a content-exact sweep is future work.
r = call("put", anchor="infer-test", text="For health, the user manages asthma with an inhaler.", keywords=["health","asthma"])
r = call("search", query="asthma inhaler", limit=5)
leaked = any("asthma" in (h.get("summary") or "") for h in r.get("results", []))
print(f"7b. derived-doc boundary: inference survives message forget (known gap = {leaked})")

# 8. stats
r = call("stats")
print(f"8. stats: evidence={json.dumps(r.get('evidence', {}))[:150]} threads={r.get('threads')}")

proc.stdin.close()
proc.wait(timeout=10)
print("\nALL SMOKE TESTS PASSED")
