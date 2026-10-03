#!/usr/bin/env bash
# CORE-180 study environments: one isolated agent environment per condition,
# each seeded with the same study repository at the same commit and the same
# two timeline bookmarks, with real (AI-enabled) Knowledge builds.
#
#   study-env.sh up <baseline|new> [--rev <commit>]   create, seed and wait until ready
#   study-env.sh check <condition>                     print the readiness report (JSON)
#   study-env.sh origin <condition>                    print the environment's origin URL
#   study-env.sh shots <condition> [dir]               screenshot the starting screens
#   study-env.sh stop <condition>                      stop the server, keep the data
#   study-env.sh start <condition>                     start a stopped environment again
#   study-env.sh destroy <condition>                   delete resources and the worktree
#
# baseline = the last commit before the Knowledge cutover (CORE-174 is 770b0599;
# its parent 75de1f32 has the old Knowledge map and search). new = main, or
# --rev. Run every session of the study against the same two builds.
#
# Never point this at the canonical development server (port 5180): every
# command goes through `vp run agent …` in the condition's own worktree.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(git -C "$HERE" rev-parse --show-toplevel)"
PARENT="$(dirname "$SOURCE")"

BASELINE_REV="75de1f3236ef9d6abb3e2800fb7d406115864262"

# The study repository (see README.md, "Repository").
UPSTREAM_URL="https://github.com/steveukx/git-js.git"
REPO_OWNER="priya"
REPO_NAME="simple-git"
MAIN_COMMIT="98864c678444d9336357c844efa4fd5a7984c0d7"
# Timeline A: the upstream commit right after MAIN_COMMIT (#1197).
TIMELINE_A="change-a"
TIMELINE_A_COMMIT="dfeb11648190b2d82a98c91768ec6e3a65bb401c"
# Timeline B: upstream 76f308e (#1195) cherry-picked onto MAIN_COMMIT with its
# original author and committer, which makes the commit id reproducible.
TIMELINE_B="change-b"
TIMELINE_B_UPSTREAM="76f308ed445013d8dd973bc515e7815b59426e3e"
TIMELINE_B_COMMIT="2b27941aae6b9e55439a3ecbf76f7f6c039609c0"

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/gitmatrix-study/core-180"
BUILD_TIMEOUT_S="${STUDY_BUILD_TIMEOUT_S:-10800}"

die() {
  echo "study-env: $*" >&2
  exit 1
}
log() { echo "study-env: $*" >&2; }

condition="${2:-}"
case "$condition" in
  baseline | new) ;;
  *) die "usage: study-env.sh <up|check|origin|shots|stop|start|destroy> <baseline|new> [...]" ;;
esac
WT="${STUDY_WORKTREE_ROOT:-$PARENT}/gitmatrix-study-$condition"
MANIFEST="$WT/.gitmatrix-agent/study-core180.json"

# `vp run agent …` in the condition's worktree; prints only the command's output.
agent() {
  (cd "$WT" && vp run agent "$@") | sed -e '/^\$ node tools\/agent\/main\.ts/d'
}
# The JSON document in an agent command's output (vp adds a banner).
json() {
  node -e '
    let s = require("fs").readFileSync(0, "utf8");
    const i = s.search(/[[{]/);
    if (i < 0) { console.error(s); process.exit(1); }
    process.stdout.write(JSON.stringify(JSON.parse(s.slice(i))));
  '
}
api() { agent gm -- api GET "$1" | json; }
field() { node -e 'const v = JSON.parse(require("fs").readFileSync(0, "utf8")); const r = new Function("v", "return " + process.argv[1])(v); console.log(typeof r === "string" ? r : JSON.stringify(r));' "$1"; }

origin() {
  # Only the origin: environment.json also holds the environment's secret.
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).origin)' \
    "$WT/.gitmatrix-agent/environment.json"
}

running() { [ -f "$WT/.gitmatrix-agent/study-up.pid" ] && kill -0 "$(cat "$WT/.gitmatrix-agent/study-up.pid")" 2>/dev/null; }

start_server() {
  if running; then
    log "server already running at $(origin)"
    return
  fi
  log "starting the server (log: $WT/.gitmatrix-agent/study-up.log)"
  (cd "$WT" && setsid nohup vp run agent up >"$WT/.gitmatrix-agent/study-up.log" 2>&1 &
    echo $! >"$WT/.gitmatrix-agent/study-up.pid")
  for _ in $(seq 1 120); do
    if agent gm -- auth status >/dev/null 2>&1; then
      log "server ready at $(origin)"
      return
    fi
    sleep 5
  done
  die "server did not become ready; see $WT/.gitmatrix-agent/study-up.log"
}

stop_server() {
  if running; then
    local pid
    pid="$(cat "$WT/.gitmatrix-agent/study-up.pid")"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$WT/.gitmatrix-agent/study-up.pid"
  (cd "$WT" && vp run agent stop) >/dev/null 2>&1 || true
}

# The upstream clone (outside every source checkout) with both timeline commits.
fetch_upstream() {
  local dir="$CACHE/git-js"
  if [ ! -d "$dir/.git" ]; then
    mkdir -p "$CACHE"
    git clone --quiet --no-checkout "$UPSTREAM_URL" "$dir"
  fi
  git -C "$dir" cat-file -e "$MAIN_COMMIT^{commit}" 2>/dev/null || git -C "$dir" fetch --quiet origin
  git -C "$dir" cat-file -e "$MAIN_COMMIT^{commit}" || die "upstream lacks $MAIN_COMMIT"
  git -C "$dir" cat-file -e "$TIMELINE_A_COMMIT^{commit}" || die "upstream lacks $TIMELINE_A_COMMIT"
  [ "$(git -C "$dir" rev-parse "$TIMELINE_A_COMMIT^")" = "$MAIN_COMMIT" ] ||
    die "timeline A is not a child of the main commit"
  if ! git -C "$dir" cat-file -e "$TIMELINE_B_COMMIT^{commit}" 2>/dev/null; then
    local pick="$CACHE/pick"
    rm -rf "$pick"
    git -C "$dir" worktree prune
    git -C "$dir" worktree add --quiet --detach "$pick" "$MAIN_COMMIT"
    local cn ce cd
    IFS=$'\t' read -r cn ce cd < <(git -C "$dir" log -1 --format='%cn%x09%ce%x09%cD' "$TIMELINE_B_UPSTREAM")
    GIT_COMMITTER_NAME="$cn" GIT_COMMITTER_EMAIL="$ce" GIT_COMMITTER_DATE="$cd" \
      git -C "$pick" -c commit.gpgsign=false -c core.hooksPath=/dev/null \
      cherry-pick "$TIMELINE_B_UPSTREAM" >/dev/null
    git -C "$dir" update-ref refs/study/change-b "$(git -C "$pick" rev-parse HEAD)"
    git -C "$dir" worktree remove --force "$pick"
  fi
  [ "$(git -C "$dir" rev-parse "$TIMELINE_B_COMMIT")" = "$TIMELINE_B_COMMIT" ] ||
    die "the timeline B cherry-pick did not reproduce $TIMELINE_B_COMMIT"
  echo "$dir"
}

seed_repository() {
  local upstream base gm
  upstream="$(fetch_upstream)"
  base="$(origin)"
  gm="$WT/apps/cli/target/debug/gm"
  if api "/repos/$REPO_OWNER/$REPO_NAME" >/dev/null 2>&1; then
    log "$REPO_OWNER/$REPO_NAME exists"
  else
    log "creating $REPO_OWNER/$REPO_NAME"
    agent gm -- repo create "$REPO_NAME" --owner "$REPO_OWNER" \
      --description "simple-git (steveukx/git-js, MIT) at $MAIN_COMMIT, for the CORE-180 study" >/dev/null
  fi
  log "pushing main and the two timeline bookmarks"
  # gm's credential helper lets plain git use the environment's sign-in.
  agent exec -- git -C "$upstream" -c credential.helper= \
    -c "credential.helper=!$gm auth git-credential" \
    push --quiet "$base/$REPO_OWNER/$REPO_NAME.git" \
    "$MAIN_COMMIT:refs/heads/main" \
    "$TIMELINE_A_COMMIT:refs/heads/timeline/$TIMELINE_A" \
    "$TIMELINE_B_COMMIT:refs/heads/timeline/$TIMELINE_B" >/dev/null
}

# One JSON report: build, Atlas snapshot and both overlays.
report() {
  local status overlays overview
  status="$(api "/repos/$REPO_OWNER/$REPO_NAME/knowledge/status")"
  overlays="$(api "/repos/$REPO_OWNER/$REPO_NAME/knowledge/overlays" || echo '{"overlays":[]}')"
  overview="$(api "/repos/$REPO_OWNER/$REPO_NAME/atlas/overview" 2>/dev/null || echo 'null')"
  node -e '
    const [status, overlays, overview, condition, main, a, b, source, rev] = process.argv.slice(1);
    const s = JSON.parse(status), o = JSON.parse(overlays).overlays ?? [], v = JSON.parse(overview);
    const build = s.recent?.find((r) => r.toCommit === main && r.status === "succeeded") ?? null;
    const timeline = (ref, commit) => {
      const x = o.find((y) => y.ref === ref);
      return x ? { ref, state: x.state, commit: x.commit, baseCommit: x.baseCommit, mergeBase: x.mergeBase,
        expected: commit, counts: x.counts, error: x.error } : { ref, state: "missing", expected: commit };
    };
    const ta = timeline("timeline/change-a", a), tb = timeline("timeline/change-b", b);
    const atlas = v && v.snapshot ? { seq: v.snapshot.seq, publishedAt: v.snapshot.publishedAt,
      partial: v.snapshot.partial, commit: v.snapshot.vector?.[0]?.commit ?? null,
      regions: v.totalRegions } : null;
    const ok = (t) => t.state === "up-to-date" && t.commit === t.expected && t.baseCommit === main;
    const ready = s.state === "up-to-date" && s.indexedCommit === main && !!build &&
      ok(ta) && ok(tb) && !!atlas && !!atlas.publishedAt && atlas.commit === main;
    console.log(JSON.stringify({ condition, gitmatrix: { rev, source }, ready,
      knowledge: { state: s.state, indexedCommit: s.indexedCommit, counts: s.counts,
        build: build && { id: build.id, status: build.status, toCommit: build.toCommit,
          startedAt: build.startedAt, finishedAt: build.finishedAt } },
      atlas, timelines: [ta, tb] }, null, 2));
  ' "$status" "$overlays" "$overview" "$condition" "$MAIN_COMMIT" "$TIMELINE_A_COMMIT" \
    "$TIMELINE_B_COMMIT" "$SOURCE" "$(git -C "$WT" rev-parse HEAD)"
}

wait_ready() {
  local deadline=$((SECONDS + BUILD_TIMEOUT_S)) out state
  while :; do
    out="$(report 2>/dev/null || true)"
    if [ -n "$out" ] && [ "$(field 'v.ready' <<<"$out")" = "true" ]; then
      echo "$out" >"$MANIFEST"
      echo "$out"
      return
    fi
    state="$( [ -n "$out" ] && field '`build ${v.knowledge.state}; overlays ${v.timelines.map((t) => t.state).join("/")}; atlas ${v.atlas ? `#${v.atlas.seq} at ${v.atlas.commit}` : "none"}`' <<<"$out" || echo "starting")"
    log "waiting: $state"
    if [ -n "$out" ] && [ "$(field 'v.knowledge.state' <<<"$out")" = "failed" ]; then
      echo "$out"
      die "the Knowledge build failed"
    fi
    [ "$SECONDS" -lt "$deadline" ] || {
      echo "$out"
      die "not ready after ${BUILD_TIMEOUT_S}s"
    }
    sleep 30
  done
}

up() {
  local rev="$BASELINE_REV"
  if [ "$condition" = new ]; then rev="main"; fi
  if [ "${3:-}" = "--rev" ]; then rev="${4:?--rev needs a commit}"; fi
  if [ ! -d "$WT" ]; then
    log "creating worktree $WT at $rev"
    gm -C "$SOURCE" worktree add "$WT" -r "$rev" >/dev/null
  fi
  log "worktree $WT is at $(git -C "$WT" rev-parse --short HEAD)"
  (cd "$WT" && vp install) >&2
  if [ ! -f "$WT/.gitmatrix-agent/environment.json" ]; then
    (cd "$WT" && vp run agent setup) >&2
  fi
  start_server
  seed_repository
  wait_ready
  log "ready: $(origin)/$REPO_OWNER/$REPO_NAME/knowledge (sign in as $REPO_OWNER)"
}

shots() {
  local out="${3:-$HERE/screenshots}"
  mkdir -p "$out"
  node "$HERE/screenshots.mjs" "$WT" "$(origin)" "$condition" "$out" "$REPO_OWNER/$REPO_NAME" "$TIMELINE_A"
}

destroy() {
  stop_server
  (cd "$WT" && vp run agent destroy) >&2
  gm -C "$SOURCE" worktree remove --force "$WT" >/dev/null
  log "destroyed the $condition environment and removed $WT"
}

case "${1:-}" in
  up) up "$@" ;;
  check) report ;;
  origin) origin ;;
  shots) shots "$@" ;;
  stop) stop_server ;;
  start) start_server ;;
  destroy) destroy ;;
  *) die "unknown command ${1:-}" ;;
esac
