# Delegation (Claude Code)

The main session runs Opus. Push work down to the cheaper models in `.claude/agents/`:

- You (the lead) own design decisions, debugging, anything ambiguous, and every outward
  action: `gm push`, issue claims and completion, `vp run agent test-ai` (paid). Never
  delegate those or the judgment behind them.
- Locating code, symbols, call sites or config → `Explore` (Haiku). Keep each request narrow:
  a scoped question, not "read the repository" (Haiku costs more past 100K tokens).
- Running `vp check`, `vp test`, `vp run ready` or reading `gm runs logs` → `runner` (Haiku).
  Don't paste raw test output into the main thread. Before pushing, act on the exit status
  it reports, never on a summary that most tests passed.
- A fully specified change touching more than three files mechanically → `implementer`
  (Sonnet), with the spec written out and the worktree path.
- After a non-trivial change, before pushing → `reviewer` (Opus, high effort, fresh context).
- Run independent `Explore` and `runner` tasks in parallel.
- Other subagents without a model of their own run on Sonnet
  (`CLAUDE_CODE_SUBAGENT_MODEL` in `.claude/settings.json`). Pass `model: "opus"` when you
  deliberately want a deep investigator on Opus.
