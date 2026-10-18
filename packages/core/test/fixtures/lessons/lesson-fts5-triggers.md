---
title: "FTS5 external-content tables need sync triggers"
kind: lesson
summary: "With content=evidence_docs, every INSERT/UPDATE/DELETE on the content table must be mirrored into the FTS index by explicit triggers or search drifts."
keywords: "fts5, triggers, external content, indexing"
---

# Lesson: FTS5 external-content sync triggers

An external-content FTS5 table does not update itself. Without the ai/ad/au
triggers the index silently drifts from the content table and search returns
stale emptiness. Learned the hard way; keep the three triggers in the schema.
