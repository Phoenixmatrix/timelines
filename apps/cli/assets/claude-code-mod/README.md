# The Claude Code work card

A Claude Code mod: a card above the prompt with the gitmatrix issue the session
works on. `gm agent mod` installs it (see apps/cli/README.md); gm embeds this
folder's runtime files (`.claude-plugin`, `hooks`, `types`).

- `hooks/register.tsx`: the hooks module (the card, the toggle, polling, and
  following the session's gm commands).
- `hooks/gm.ts`: pure logic over gm's JSON and the session's commands.
- `types/index.d.ts`: the mod's `$.state` contract.

## Developing it

Load this folder in Claude Code: it reloads on every save.

```bash
claude --plugin-dir apps/cli/assets/claude-code-mod
```

Claude Code then lays its API declarations in `.claude-plugin/types/`
(git-ignored), which `tsconfig.json` extends; repository lint skips this folder
because those declarations only exist once Claude Code has loaded it.

```bash
claude plugin validate apps/cli/assets/claude-code-mod
tsc -p apps/cli/assets/claude-code-mod                # after a load
node --test apps/cli/assets/claude-code-mod/tests/*.test.ts   # also in cli#test
```

The tests are Node unit tests of `hooks/gm.ts`, not `claude plugin test` ones.
