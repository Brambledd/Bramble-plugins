---
title: "Choose node:sqlite as the evidence store driver"
status: accepted
kind: decision
summary: "node:sqlite ships FTS5 (trigram) in the Node runtime itself, so the derived evidence index needs zero native addons."
keywords: "sqlite, fts5, driver, evidence"
---

# ADR-001: Choose node:sqlite as the evidence store driver

The memory evidence index uses `node:sqlite` with the FTS5 trigram tokenizer.
Rationale: the driver is part of the Node runtime (22.5+), FTS5 is compiled in,
and WAL mode plus busy_timeout cover the single-writer access pattern.

Consequences: no better-sqlite3 native build step; SQLite 3.34+ trigram gives
CJK substring matching for three-or-more character terms.
