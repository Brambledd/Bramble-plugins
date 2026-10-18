---
title: "Drill reads must fail closed on revision mismatch"
status: accepted
kind: decision
summary: "memory_drill re-hashes the source file and refuses to serve content when it no longer matches the indexed revision."
keywords: "drill, revision, fail-closed, verification"
---

# ADR-002: Drill reads must fail closed

Every derived read goes back to the source: the stored `source_hash` is the
revision, and drill re-reads plus re-hashes the file before returning content.
A mismatch returns `not_available` with a machine-readable reason instead of
stale content. Superseded or retired evidence is demoted and never drilled.
