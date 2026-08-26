---
name: muxpilot-documents
description: Maintain durable session Markdown documents for plans, checklists, requirements, reminders, decisions, progress, and acceptance criteria.
---

# Muxpilot Documents

Use the exact directory in `$MUXPILOT_DOCUMENTS_DIR` for agent-managed notes that must survive context compaction, session restore, or long-running work. Resolve that environment variable before writing and keep every document beneath it. The session working directory is not the documents directory: never place `INDEX.md` or another muxpilot document in the session cwd, repository, or another session's directory. Do not create a document merely to restate a short conversation; use documents when durable working state will materially help.

Before substantive work on each turn, after a resume, and after context compaction, inspect the existing documents. Read `INDEX.md` first when present, then the documents relevant to the current task. Treat the user's latest instructions as authoritative if a document is stale or conflicts with them.

Keep documents current after material progress, decisions, scope changes, newly discovered requirements, and completed checklist items. Update them before asking a blocking question or giving a final answer. When documents exist, maintain `INDEX.md` as a concise map of their purpose and current relevance.

Each muxpilot session owns a private document scope. When a parent coordinates an agent-created muxpilot child session, the parent's documents are canonical and read-only to that child. The child may read parent documents only when the task explicitly supplies them, keeps any private working notes in its own `$MUXPILOT_DOCUMENTS_DIR`, and returns a structured document handoff containing verified evidence plus proposed plan, acceptance, and workflow updates. Built-in Codex subagents share the current session environment and documents scope; they must not edit session documents and instead return proposed updates to the main agent. The parent independently verifies every handoff before updating its canonical documents. Never attempt a cross-session document write.

The muxpilot BTW flow is a controlled exception for operator-requested document creation and editing. A BTW agent may write only to the isolated documents staging directory muxpilot gives it, may not delete or rename documents, and never writes the canonical scope directly. Muxpilot validates and applies that staging diff at the next safe main-session boundary, then privately tells the main agent which documents changed. On that notice, re-read the changed documents, reconcile them with the latest operator instructions, and continue owning and updating the canonical documents without interrupting the ongoing task.

Use only flat UTF-8 Markdown files with names made from letters, numbers, dots, underscores, and hyphens and ending in `.md`. Do not create nested directories, dotfiles, symlinks, or non-Markdown files. Keep at most 100 documents, each no larger than 256 KiB and no more than 10 MiB total.

Documents are private working state, not a secret store or an audit log. Do not put credentials, tokens, private keys, raw transcripts, or unnecessary sensitive data in them. Prefer concise facts, explicit checklists, sources of truth, open questions, reminders, and acceptance criteria.
