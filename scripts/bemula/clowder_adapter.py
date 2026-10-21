"""Clowder AI memory adapter for the Bemula benchmark.

Fork of bramble_adapter.py with the deletion execution delegated to the
Clowder product pipeline: intent parsing (LLM plan) stays identical — that
layer belongs to the agent in Clowder's architecture, and the adapter stands
in for the agent in the benchmark — but everything downstream of the plan
(scope routing, multi-probe retrieval, fresh-write guard, message-level
suppression, residual verification, F6 replacement) runs inside the REAL
ForgetService + IndexBuilder via clowder_bridge.mjs.

What this measures: whether the product port preserved the benchmark-
validated deletion behavior (Bramble lite5l scored 0.469 with its own
pipeline; this run answers the same questions for Clowder's).
"""

from __future__ import annotations

import os
import subprocess
import json
from pathlib import Path
from typing import Any

from bemula.llm import BaseLLM

import bramble_adapter as _base


class _ClowderBridge(_base._Bridge):
    """Same line-JSON-RPC client, pointed at clowder_bridge.mjs.

    The bridge must run under Node 22 (better-sqlite3 ships prebuilt
    win32-x64 binaries for its ABI; Node 26 has none). The node binary is
    resolved WITHOUT touching PATH: CLOWDER_NODE env → the nvm v22 install
    → plain 'node'.
    """

    def _node_binary(self) -> str:
        env = os.environ.get("CLOWDER_NODE", "").strip()
        if env:
            return env
        candidate = Path(os.environ.get("NVM_HOME", r"C:\Users\19356\AppData\Local\nvm")) / "v22.14.0" / "node.exe"
        if candidate.exists():
            return str(candidate)
        return "node"

    def __init__(self) -> None:
        bridge = Path(__file__).resolve().parent / "clowder_bridge.mjs"
        err_target = (
            open(Path(__file__).resolve().parent / "clowder_bridge_stderr.log", "a", encoding="utf-8")
            if os.environ.get("CLOWDER_BRIDGE_LOG")
            else subprocess.DEVNULL
        )
        self.proc = subprocess.Popen(
            [self._node_binary(), str(bridge)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=err_target,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )


class ClowderAdapter(_base.BrambleAdapter):
    """Clowder AI evidence pipeline under the Bemula protocol."""

    name = "clowder"

    def __init__(self, llm: BaseLLM, top_k: int = 10) -> None:
        # Skip the parent __init__ bridge (it would spawn bridge.mjs).
        self.llm = llm
        self.top_k = top_k
        self.bridge = _ClowderBridge()
        self._consolidated_at_turn = 0
        self._pending_anchors: list[str] = []
        self.reset()

    # The one substantive override: forget execution goes to the product
    # ForgetService. Everything else (observe, consolidation, query, plan
    # generation) is inherited unchanged from the Bramble adapter.
    def _handle_forget_request(self, text: str) -> None:
        plan = self._plan_forget(text)
        # plan.facts (enumerated fact phrases) are stronger search targets
        # than the short topic targets — merge, cap at the tool's 12.
        targets: list[str] = []
        for phrase in (plan.get("facts") or []) + (plan.get("targets") or []):
            if phrase not in targets:
                targets.append(str(phrase))
        result = self.bridge.call(
            "forget",
            scope=plan.get("scope") or "facts",
            targets=targets[:12],
            since=plan.get("since"),
            until=plan.get("until"),
            replacement=plan.get("replacement"),
            evidenceScope="threads",
        )
        if not result.get("ok"):
            raise RuntimeError(f"clowder forget failed: {result.get('error')}")
