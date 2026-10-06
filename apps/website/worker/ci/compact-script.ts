/** Trusted script: no repository commands, hooks or config participate in materialization. */
export const COMPACT_SCRIPT = String.raw`set -euo pipefail
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $GITMATRIX_TOKEN"
export GIT_AUTHOR_NAME="$GITMATRIX_LANDING_NAME" GIT_COMMITTER_NAME="$GITMATRIX_LANDING_NAME"
export GIT_AUTHOR_EMAIL="$GITMATRIX_LANDING_EMAIL" GIT_COMMITTER_EMAIL="$GITMATRIX_LANDING_EMAIL"
export GIT_AUTHOR_DATE="$GITMATRIX_LANDING_DATE" GIT_COMMITTER_DATE="$GITMATRIX_LANDING_DATE"
remote="$GITMATRIX_URL/$GITMATRIX_REPOSITORY.git"
work="$GITMATRIX_URL/$GITMATRIX_REPOSITORY@$GITMATRIX_LANDING_TIMELINE.git"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
# Fresh bare databases exclude repository hooks, attributes config and checkout filters.
git init --quiet --bare "$root/materialize"
git -C "$root/materialize" fetch --quiet "$work" "$GITMATRIX_COMMIT" "$GITMATRIX_LANDING_LOGICAL_COMMIT"
git -C "$root/materialize" fetch --quiet "$remote" "$GITMATRIX_LANDING_BASE"
cd "$root/materialize"
test "$(git rev-parse "$GITMATRIX_COMMIT^{tree}")" = "$GITMATRIX_LANDING_SOURCE_TREE"
test "$(git rev-parse "$GITMATRIX_LANDING_LOGICAL_COMMIT^{tree}")" = "$GITMATRIX_LANDING_LOGICAL_TREE"
# Synthetic ancestry expresses EXACT B/O/T, never a heuristic merge-base of WIP history.
b=$(printf 'logical base\n' | git commit-tree "$GITMATRIX_LANDING_LOGICAL_TREE")
o=$(printf 'canonical\n' | git commit-tree "$(git rev-parse "$GITMATRIX_LANDING_BASE^{tree}")" -p "$b")
t=$(printf 'approved work\n' | git commit-tree "$GITMATRIX_LANDING_SOURCE_TREE" -p "$b")
if ! git -c merge.renames=true merge-tree --write-tree "$o" "$t" > "$root/result"; then
  cat "$root/result"
  exit 42
fi
read -r tree < "$root/result"
# A second fresh database receives canonical history and ONLY result tree/blob objects.
# pack-objects starts at a tree, so neither WIP nor synthetic commits can be published.
git init --quiet --bare "$root/publish"
git -C "$root/publish" fetch --quiet "$remote" "$GITMATRIX_LANDING_BASE"
printf '%s\n' "$tree" | git pack-objects --revs --stdout | git -C "$root/publish" index-pack --stdin
cd "$root/publish"
if [ "$tree" = "$(git rev-parse "$GITMATRIX_LANDING_BASE^{tree}")" ]; then
  candidate="$GITMATRIX_LANDING_BASE"
else
  candidate=$(printf '%s\n' "$GITMATRIX_LANDING_MESSAGE" | git commit-tree "$tree" -p "$GITMATRIX_LANDING_BASE")
fi
git push --quiet --force-with-lease="refs/heads/$GITMATRIX_LANDING_BRANCH:$GITMATRIX_LANDING_OLD" "$remote" "$candidate:refs/heads/$GITMATRIX_LANDING_BRANCH"
echo "Compact candidate $candidate tree $tree"
`;
