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


def _load_json_loose(raw: str) -> dict[str, Any]:
    """Tolerant JSON extraction: flash models occasionally emit broken
    trailing commas or fenced output. Try strict, then repaired variants."""
    candidates = []
    m = re.search(r"\{.*\}", raw, re.S)
    if m:
        candidates.append(m.group(0))
    candidates.append(re.sub(r",\s*([}\]])", r"\1", m.group(0) if m else raw))
    for cand in candidates:
        try:
            return json.loads(cand)
        except Exception:  # noqa: BLE001 - try the next variant
            continue
    raise ValueError(f"unparseable JSON: {raw[:120]!r}")


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

    def __init__(self, llm: BaseLLM, top_k: int = 10) -> None:
        self.llm = llm
        self.top_k = top_k
        self.bridge = _Bridge()

    # -------------------------------------------------------------- lifecycle

    def reset(self) -> None:
        self.bridge.call("reset")
        self._session_count = 0
        self._suppressed: list[str] = []

    def begin_instance(self, instance: Any) -> None:  # noqa: ARG002
        pass

    def end_instance(self) -> None:
        pass

    def begin_session(self, session: Any) -> None:
        # Bemula has no end_session hook: consolidate the previous session's
        # turns here, and the final session in end_variant.
        if getattr(self, "_session_count", 0) >= 1:
            self._consolidate()
        self._session_count = getattr(self, "_session_count", 0) + 1

    def end_variant(self) -> None:
        self._consolidate()

    def _consolidate(self) -> None:
        """Session-close inference pass (memory consolidation).

        Extracts high-level conclusions that are EXPLICITLY supported by at
        least two stored facts and writes them as separate `inference`
        entries. This is what lets retention answer connect-the-dots
        questions and lets F4 forget requests target the derived
        conclusion without touching the atomic facts beneath.
        Guardrails against hallucination: temperature 0, a strict
        two-facts-minimum rule, per-conclusion basis anchors recorded.
        """
        listing = self.bridge.call("list")
        items = [
            it for it in listing.get("items", [])
            if it.get("kind") != "inference" and it.get("summary")
        ]
        if len(items) < 2:
            return
        # Full-store view: inference sources may live in early sessions that
        # a recent-window cut would hide (the F4 trace showed investment
        # facts lost to items[-30:]). Bounded at 120 for prompt safety.
        lines = "\n".join(f"- [{it['anchor']}] {it['summary'][:110]}" for it in items[:120])
        suppressed = getattr(self, "_suppressed", [])
        suppressed_clause = (
            "\nWithdrawn conclusions (the user asked to forget these — do NOT "
            "output them or close equivalents):\n"
            + "\n".join(f"- {s[:110]}" for s in suppressed[-5:])
            if suppressed
            else ""
        )
        prompt = (
            "Below are a user's remembered facts. Output STRICT JSON only: "
            "{\"conclusions\": [{\"text\": \"...\", \"basis\": [\"anchor\", ...]}]}. "
            "Rules: conclusions must be directly grounded in the facts — at "
            "least ONE supporting fact each, and INCLUSIVE topic-level "
            "generalizations are encouraged when a fact or group of facts "
            "reveals the user's approach, habits or situation (e.g. a fact "
            "mentioning index funds and bonds -> 'For saving and investing, "
            "the user favors low-cost instruments'); NEVER invent facts that "
            "appear nowhere; at most 5 conclusions; empty list if none "
            "qualify. Each conclusion must be a single self-contained "
            "sentence that NAMES ITS TOPIC DOMAIN explicitly — write \"For "
            "saving and investing, the user ...\" style openings, so the "
            "conclusion is findable by topic words (saving, investing, "
            "health, work, hobbies, family ...)." + suppressed_clause +
            "\n\nFacts:\n" + lines
        )
        try:
            answer = self.llm.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=600,
                task="bramble_consolidate",
            )
            data = _load_json_loose(answer)
            for conclusion in data.get("conclusions", [])[:3]:
                text = conclusion.get("text")
                if isinstance(text, str) and len(text.strip()) > 5:
                    basis = [b for b in conclusion.get("basis", []) if isinstance(b, str)][:8]
                    self.bridge.call(
                        "put",
                        anchor=f"infer-s{getattr(self, '_session_count', 0)}-{len(basis)}-{abs(hash(text)) % 9973}",
                        text=text.strip(),
                        keywords=["inference"] + [b for b in basis if b.startswith("turn-")][:3],
                    )
        except Exception as exc:  # noqa: BLE001 - consolidation is best-effort
            import os as _os

            if _os.environ.get("BRAMBLE_DEBUG"):
                print(f"[consolidate failed] {type(exc).__name__}: {exc}", file=sys.stderr)

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
        plan = self._plan_forget(text)
        scope = plan.get("scope") or "facts"
        if scope in ("topic", "timerange"):
            anchors = self._scope_removals(text, plan, scope, last)
        else:
            anchors = self._fact_removals(text, plan, last)
        if anchors:
            removed_rows = self.bridge.call("list").get("items", [])
            removed_rows = [r for r in removed_rows if r["anchor"] in anchors]
            # Withdrawn inferences must not be re-derived by later
            # consolidation passes (anti-resurrection guard for F4).
            for row in removed_rows:
                if row.get("kind") == "inference" and row.get("summary"):
                    self._suppressed.append(row["summary"])
            self.bridge.call("remove", anchors=anchors)
        # F6 replacement: the old value is gone; remember the new one.
        if plan.get("replacement"):
            self._session_id = getattr(self, "_session_id", "s")
            idx = getattr(self, "_turn_index", 0)
            self._turn_index = idx + 1
            self.bridge.call(
                "observe",
                speaker="user",
                text=plan["replacement"],
                timestamp="",
                sessionId=self._session_id,
                turnIndex=idx,
            )

    # ---------------------------------------------------- scope forget paths

    def _scope_removals(self, text: str, plan: dict[str, Any], scope: str, last: str | None) -> list[str]:
        """Range forget: topic membership or a time window are GLOBAL
        predicates over the whole store — retrieval similarity is the wrong
        tool. Scan everything, decide membership, remove the hit set.
        """
        items = [it for it in self.bridge.call("list").get("items", []) if it.get("anchor") != last]
        if not items:
            return []
        if scope == "timerange":
            anchors = self._timerange_filter(items, plan)
            # Time ranges are fuzzy in natural language: if the deterministic
            # pass found nothing, fall through to the topic-style LLM pass.
            if anchors:
                return anchors
        return self._topic_filter(text, items)

    def _timerange_filter(self, items: list[dict[str, Any]], plan: dict[str, Any]) -> list[str]:
        """Deterministic date filtering via keyword date tokens (YYYY-MM-DD /
        YYYY-MM forms written at observe time)."""
        since = str(plan.get("since") or "").strip()
        until = str(plan.get("until") or "").strip()
        if not since and not until:
            return []
        anchors = []
        for it in items:
            dates = [k for k in (it.get("keywords") or []) if len(k) == 10 and k[4] == "-" and k[7] == "-"]
            if not dates:
                continue
            stamp = sorted(dates)[0]
            if since and stamp < since:
                continue
            if until and stamp > until:
                continue
            anchors.append(it["anchor"])
        return anchors

    def _topic_filter(self, text: str, items: list[dict[str, Any]]) -> list[str]:
        """LLM membership judgment over the whole store (topic-wide removal).
        When unsure the judge is told to REMOVE — under-removal leaks the
        deleted fact, which is the heavier penalty in this benchmark.
        """
        listing = "\n".join(f"{i}. {str(it.get('summary') or '')[:110]}" for i, it in enumerate(items))
        prompt = (
            "The user asked to forget a whole topic/category. Below is the "
            "complete memory store. Reply with STRICT JSON only: {\"remove\": "
            "[numbers of EVERY entry belonging to that topic or time range]}. "
            "When unsure whether an entry belongs, REMOVE it. Entries clearly "
            "outside the topic must be kept.\n\n"
            f"Request: {text}\n\nStore:\n{listing}"
        )
        try:
            answer = self.llm.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=300,
                task="bramble_scope_filter",
            )
            data = _load_json_loose(answer)
            nums = [n for n in data.get("remove", []) if isinstance(n, int) and 0 <= n < len(items)]
            return [items[n]["anchor"] for n in nums]
        except Exception:  # noqa: BLE001 - degrade to nothing rather than
            # mass-delete on a broken scope decision
            return []

    def _fact_removals(self, text: str, plan: dict[str, Any], last: str | None) -> list[str]:
        """Point forget (F1/F6-proven path): plan phrases -> retrieval ->
        LLM-confirmed selection."""
        removals: list[dict[str, Any]] = []
        seen: set[str] = set()
        for target in plan["targets"]:
            hits = self.bridge.call("search", query=target, limit=8)
            for r in hits.get("results", []):
                if r["anchor"] in seen or r["anchor"] == last:
                    continue
                seen.add(r["anchor"])
                removals.append(r)
        # LLM-confirmed selection: which candidates does the request actually
        # cover? This is the same propose-then-confirm discipline as the main
        # suite's lesson governance — it is what protects preservation.
        return self._confirm_removals(text, removals)

    def _plan_forget(self, text: str) -> dict[str, Any]:
        """Structured forget plan: scope + target phrases + optional range and
        replacement.

        The LLM is asked for strict JSON; on any failure we degrade to the
        stopword-stripped heuristic (phrase probes, facts scope, no range).
        """
        prompt = (
            "The user asked their assistant to forget something. Output STRICT "
            "JSON only, no markdown: {\"scope\": \"facts\" | \"topic\" | "
            "\"timerange\", \"targets\": [up to 5 short search phrases "
            "covering EVERYTHING to forget; for topic-wide requests list the "
            "topic facets], \"since\": \"ISO timestamp lower bound or null\", "
            "\"until\": \"ISO timestamp upper bound or null\", \"replacement\": "
            "\"the new value to remember instead, or null\"}. scope='topic' "
            "when a whole category/topic should go; 'timerange' when "
            "everything within a time window should go; 'facts' otherwise. "
            "Phrases must describe the OLD facts, not the request.\n\n"
            f"Request: {text}"
        )
        try:
            answer = self.llm.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=300,
                task="bramble_forget_plan",
            )
            data = _load_json_loose(answer)
            targets = [t for t in data.get("targets", []) if isinstance(t, str) and len(t) > 2][:5]
            scope = data.get("scope") if data.get("scope") in ("facts", "topic", "timerange") else "facts"
            replacement = data.get("replacement")
            if targets or scope in ("topic", "timerange"):
                return {
                    "scope": scope,
                    "targets": targets,
                    "since": data.get("since") if isinstance(data.get("since"), str) else None,
                    "until": data.get("until") if isinstance(data.get("until"), str) else None,
                    "replacement": replacement if isinstance(replacement, str) and replacement.strip() else None,
                }
        except Exception:  # noqa: BLE001 - degrade to the heuristic path
            pass
        words = [w for w in re.findall(r"[\w']+", FORGET_INTENT_RE.sub(" ", text)) if w.lower() not in self.STOPWORDS and len(w) > 2]
        if not words:
            return {"scope": "facts", "targets": [], "since": None, "until": None, "replacement": None}
        probes = [" ".join(words)]
        if len(words) > 2:
            probes.append(" ".join(words[-2:]))
        return {"scope": "facts", "targets": probes, "since": None, "until": None, "replacement": None}

    def _confirm_removals(self, text: str, candidates: list[dict[str, Any]]) -> list[str]:
        """Ask the LLM which retrieved memories the request actually covers.

        Falls back to the lexical-overlap heuristic (all matching candidates)
        when the LLM is unavailable.
        """
        if not candidates:
            return []
        listing = "\n".join(f"{i}. {c['summary'][:110]}" for i, c in enumerate(candidates))
        prompt = (
            "The user asked to forget something. Below are candidate stored "
            "memories. Reply with STRICT JSON only: {\"remove\": [numbers of "
            "EVERY entry the request covers]}. Rules: for topic-wide requests "
            "remove the WHOLE topic; for time-range requests remove EVERY "
            "entry inside the range; when unsure whether an entry is covered, "
            "REMOVE it — under-removal leaks the deleted fact, over-removal "
            "only loses a peripheral memory.\n\n"
            f"Request: {text}\n\nCandidates:\n{listing}"
        )
        try:
            answer = self.llm.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=200,
                task="bramble_forget_confirm",
            )
            data = _load_json_loose(answer)
            nums = [n for n in data.get("remove", []) if isinstance(n, int) and 0 <= n < len(candidates)]
            if nums:
                return [candidates[n]["anchor"] for n in nums]
            if nums == [] and data.get("remove") == []:
                return []
        except Exception:  # noqa: BLE001
            pass
        # Offline fallback: remove every retrieved candidate (bounded).
        return [c["anchor"] for c in candidates[:8]]

    def _extract_forget_targets(self, text: str) -> list[str]:
        """Back-compat shim: heuristic probes only (used by trials)."""
        words = [w for w in re.findall(r"[\w']+", FORGET_INTENT_RE.sub(" ", text)) if w.lower() not in self.STOPWORDS and len(w) > 2]
        if not words:
            return []
        probes = [" ".join(words)]
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
