"""Bramble memory adapter for the Bemula benchmark.

Drives the real Bramble evidence store (SQLite + FTS5 + vector lane) through
a long-lived Node bridge process. This adapter takes the honest route:
forget requests arrive as ordinary dialogue turns and must be *recognized*
from their natural language, then resolved to stored memories by retrieval,
then removed through the store's public removal API. No benchmark metadata
(``linked_fact_ids`` etc.) is consulted — that is the evaluation's ground
truth, and using it would be cheating on exactly the skill being measured.

Forget-intent recognition and answer generation use the agent LLM passed by
the runner (``BEMULA_AGENT_MODEL``), mirroring how a real Bramble agent
would interpret the request.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from bemula.baselines.base import MemoryAdapter
from bemula.llm import BaseLLM
from bemula.schemas import Turn

# Bridge location: sibling of this file by default, overridable for installs.
_BRIDGE_DEFAULT = Path(__file__).resolve().parent / "bridge.mjs"
_BRAMBLE_ROOT = os.environ.get("BRAMBLE_PLUGINS_DIR")

FORGET_INTENT_RE = re.compile(
    r"(?i)\b(forget|delete|remove|erase|scrub|purge|don'?t (?:remember|store|keep)"
    r"|stop remembering|no longer (?:remember|relevant)"
    r"|忘(?:掉|了|记|记掉)?|删除|删掉|抹掉|别再记|不要再记|不用记得|不需要记得)\b"
)

REPLACE_HINT_RE = re.compile(r"(?i)\b(instead of|rather than|replace|now it'?s|changed to|换成|改为|不再是)")


class _Bridge:
    """Line-delimited JSON-RPC client for the Node bridge process."""

    def __init__(self) -> None:
        bridge = _BRIDGE_DEFAULT
        if _BRAMBLE_ROOT:
            candidate = Path(_BRAMBLE_ROOT) / "scripts" / "bemula" / "bridge.mjs"
            if candidate.exists():
                bridge = candidate
        # node is required; fail loud if absent.
        self.proc = subprocess.Popen(
            ["node", str(bridge)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

    def call(self, op: str, **payload: Any) -> dict[str, Any]:
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps({"op": op, **payload}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("bramble bridge terminated")
        return json.loads(line)

    def close(self) -> None:
        try:
            self.proc.stdin.close()  # type: ignore[union-attr]
            self.proc.wait(timeout=5)
        except Exception:  # noqa: BLE001 - best-effort shutdown
            self.proc.kill()


class BrambleAdapter(MemoryAdapter):
    """Bramble evidence store under the Bemula protocol."""

    name = "bramble"

    def __init__(self, llm: BaseLLM, top_k: int = 5) -> None:
        self.llm = llm
        self.top_k = top_k
        self.bridge = _Bridge()

    # -------------------------------------------------------------- lifecycle

    def reset(self) -> None:
        self.bridge.call("reset")

    def begin_instance(self, instance: Any) -> None:  # noqa: ARG002
        pass

    def end_instance(self) -> None:
        pass

    def begin_session(self, session: Any) -> None:  # noqa: ARG002
        pass

    def end_variant(self) -> None:
        pass

    def close(self) -> None:
        self.bridge.close()

    # --------------------------------------------------------------- observe

    def observe(self, turn: Turn) -> None:
        if turn.speaker != "user":
            return  # only user turns carry memorable statements
        self._session_id = getattr(self, "_session_id", "s")
        idx = getattr(self, "_turn_index", 0)
        self._turn_index = idx + 1
        result = self.bridge.call(
            "observe",
            speaker=turn.speaker,
            text=turn.text,
            timestamp=turn.timestamp,
            sessionId=getattr(turn, "session_id", None) or self._session_id,
            turnIndex=idx,
        )
        self._last_anchor = result.get("anchor")
        # A user turn that looks like a forget request triggers removal.
        if FORGET_INTENT_RE.search(turn.text):
            self._handle_forget_request(turn.text)

    # ----------------------------------------------------------- forget path

    # Politeness / filler words that pollute AND-style retrieval: the request
    # turn itself matches every one of them, so the real target never wins.
    STOPWORDS = {
        "please", "kindly", "just", "now", "also", "the", "a", "an", "of",
        "about", "my", "me", "i", "you", "your", "that", "this", "those",
        "fact", "facts", "information", "memory", "record", "records",
        "thing", "things", "details", "from", "mind", "and", "to", "for",
    }

    def _handle_forget_request(self, text: str) -> None:
        # The request turn itself must not survive as a memory, and it must
        # not pollute target retrieval: drop it first, then resolve targets.
        last = getattr(self, "_last_anchor", None)
        if last:
            self.bridge.call("remove", anchors=[last])
            self._last_anchor = None
        for target in self._extract_forget_targets(text):
            hits = self.bridge.call("search", query=target, limit=5)
            anchors = [
                r["anchor"]
                for r in hits.get("results", [])
                if r["anchor"] != last and self._match(target, r)
            ]
            if anchors:
                self.bridge.call("remove", anchors=anchors[:5])

    def _extract_forget_targets(self, text: str) -> list[str]:
        """Ask the agent LLM what facts the user wants forgotten.

        Falls back to the raw text (minus intent words and stopwords) when
        the LLM is unavailable, so offline smoke runs still exercise the
        pipeline.
        """
        prompt = (
            "The user asked their assistant to forget something. Extract the "
            "specific fact(s)/topic(s) to be forgotten as short search phrases, "
            "one per line, max 3. If the request replaces an old value with a "
            "new one, output ONLY the old value's phrase. No commentary.\n\n"
            f"Request: {text}"
        )
        try:
            answer = self.llm.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=128,
                task="bramble_forget_parse",
            )
            phrases = [ln.strip("-• \t") for ln in answer.splitlines() if ln.strip()]
            phrases = [p for p in phrases if len(p) > 2][:3]
            if phrases:
                return phrases
        except Exception:  # noqa: BLE001 - degrade to the heuristic path
            pass
        # Heuristic: strip intent markers, stopwords and filler, then search
        # with the content words that remain.
        cleaned = FORGET_INTENT_RE.sub(" ", text)
        cleaned = REPLACE_HINT_RE.sub(" ", cleaned)
        words = [w for w in re.findall(r"[\w']+", cleaned) if w.lower() not in self.STOPWORDS and len(w) > 2]
        if not words:
            return []
        # Two probes: the full content-word phrase, and the longest bigram —
        # single AND queries can otherwise be over-constrained.
        phrase = " ".join(words)
        probes = [phrase]
        if len(words) > 2:
            probes.append(" ".join(words[-2:]))
        return probes

    @staticmethod
    def _match(target: str, result: dict[str, Any]) -> bool:
        """Accept a retrieved memory when it lexically overlaps the target."""
        target_words = {w.lower() for w in re.findall(r"[\w']+", target) if len(w) > 2}
        if not target_words:
            return False
        hay = f"{result.get('title', '')} {result.get('summary', '')}".lower()
        overlap = sum(1 for w in target_words if w in hay)
        return overlap >= max(1, len(target_words) // 2)

    # ----------------------------------------------------------------- query

    def query(self, question: str) -> str:
        hits = self.bridge.call("search", query=question, limit=self.top_k)
        results = hits.get("results", [])
        if not results:
            return "I don't have any relevant information stored."
        context = "\n".join(f"- {r['summary']}" for r in results)
        prompt = (
            "You are a personal assistant with access to remembered conversation "
            "history. Answer the user's question using ONLY the context below. "
            "If the answer is not in the context, say you don't have that "
            "information. Keep the answer short.\n\n"
            f"Context:\n{context}\n\nQuestion: {question}"
        )
        try:
            return self.llm.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=512,
                task="bramble_answer",
            )
        except Exception:  # noqa: BLE001 - offline fallback returns evidence verbatim
            return context
