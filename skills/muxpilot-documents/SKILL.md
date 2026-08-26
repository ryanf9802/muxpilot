---
name: muxpilot-documents
description: Maintain durable session Markdown documents for plans, checklists, requirements, reminders, decisions, progress, and acceptance criteria.
---

# Muxpilot Documents

Use the directory in `$MUXPILOT_DOCUMENTS_DIR` for agent-managed notes that must survive context compaction, session restore, or long-running work. Do not create a document merely to restate a short conversation; use documents when durable working state will materially help.

Before substantive work on each turn, after a resume, and after context compaction, inspect the existing documents. Read `INDEX.md` first when present, then the documents relevant to the current task. Treat the user's latest instructions as authoritative if a document is stale or conflicts with them.

Keep documents current after material progress, decisions, scope changes, newly discovered requirements, and completed checklist items. Update them before asking a blocking question or giving a final answer. When documents exist, maintain `INDEX.md` as a concise map of their purpose and current relevance.

Use only flat UTF-8 Markdown files with names made from letters, numbers, dots, underscores, and hyphens and ending in `.md`. Do not create nested directories, dotfiles, symlinks, or non-Markdown files. Keep at most 100 documents, each no larger than 256 KiB and no more than 10 MiB total.

Documents are private working state, not a secret store or an audit log. Do not put credentials, tokens, private keys, raw transcripts, or unnecessary sensitive data in them. Prefer concise facts, explicit checklists, sources of truth, open questions, reminders, and acceptance criteria.
