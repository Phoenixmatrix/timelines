//! The command manifest: clap's definitions plus what clap doesn't know
//! (git equivalents, search keywords, output shape, examples). Like `cf`,
//! one manifest drives `--help`, `gm cli search`, `gm cli commands` and
//! `gm schema`.

use crate::model;
use crate::output::{GmError, Render, Result};
use clap::CommandFactory;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub enum Out {
    /// A JSON Schema generated from the output type.
    Typed(fn() -> Value),
    /// JSON shape described in words (server passthrough commands).
    Other(&'static str),
}

const OP: Out = Out::Typed(schema_of::<model::OpResult>);

pub struct Meta {
    pub path: &'static str,
    pub git: &'static str,
    pub keywords: &'static str,
    pub mutates: bool,
    pub out: Out,
    pub examples: &'static [&'static str],
}

macro_rules! meta {
    ($path:expr, git: $git:expr, kw: $kw:expr, mutates: $m:expr, out: $out:expr, ex: [$($ex:expr),* $(,)?]) => {
        Meta { path: $path, git: $git, keywords: $kw, mutates: $m, out: $out, examples: &[$($ex),*] }
    };
}

pub const COMMANDS: &[Meta] = &[
    meta!("tracker list", git: "", kw: "accounts organizations issue trackers", mutates: false, out: Out::Other("{trackers:[{id,slug,displayName,canAdmin}]}"), ex: ["gm tracker list"]),
    meta!("tracker use", git: "", kw: "select owner initialize offline replica account organization", mutates: true, out: Out::Other("{owner,identity,replica,cursor}"), ex: ["gm tracker use orbit"]),
    meta!("tracker sync", git: "", kw: "offline replica outbox synchronize upload download cursor", mutates: true, out: Out::Other("{dryRun,cursor,pending}; conflicts stop ordered replay without dropping later edits"), ex: ["gm tracker sync"]),
    meta!("tracker status", git: "", kw: "replica pending queue identity cache path", mutates: false, out: Out::Other("{owner,identity,cursor,operations,replica,credentialPartitions,credentialRotation}"), ex: ["gm tracker status --offline"]),
    meta!("tracker conflicts", git: "", kw: "stale version collision local remote rejected edits", mutates: false, out: Out::Other("{operations,remote:Snapshot,local:Snapshot,resolution}"), ex: ["gm tracker conflicts"]),
    meta!("tracker resolve", git: "", kw: "resolve conflict accept server reapply local explicit", mutates: true, out: Out::Other("{resolved,strategy,pending,next}"), ex: ["gm tracker resolve OPERATION --strategy reapply-local"]),
    meta!("tracker recover", git: "", kw: "credential rotation token identity recover old replica outbox", mutates: true, out: Out::Other("{dryRun,recovered,source,replica,next}"), ex: ["gm tracker recover /private/old/orbit.sqlite --owner orbit"]),
    meta!("tracker changes", git: "", kw: "events cursor incremental change feed", mutates: false, out: Out::Other("{events:[{cursor,operationId,actorId,kind,entityType,entityId,entity,createdAt}],cursor,hasMore,serverTime}"), ex: ["gm tracker changes --after 10 --limit 50"]),
    meta!("team list", git: "", kw: "teams membership issue prefixes", mutates: false, out: Out::Other("{teams:[Team],offline,cursor}"), ex: ["gm team list"]),
    meta!("team create", git: "", kw: "create team issue key prefix", mutates: true, out: Out::Other("{operationId,queued,entities:[Team],cursor}"), ex: ["gm team create ENG --name Engineering"]),
    meta!("team update", git: "", kw: "team membership archive rename description", mutates: true, out: Out::Other("{operationId,queued,entities:[Team],cursor}"), ex: ["gm team update ENG --data '{\"name\":\"Platform\"}'"]),
    meta!("workspace list", git: "", kw: "cross team workspace projects subscriptions", mutates: false, out: Out::Other("{workspaces:[Workspace],subscriptions:[Subscription],offline,cursor}"), ex: ["gm workspace list"]),
    meta!("workspace create", git: "", kw: "project area cross team workspace create", mutates: true, out: Out::Other("{operationId,queued,entities:[Workspace],cursor}"), ex: ["gm workspace create launch --name Launch"]),
    meta!("workspace update", git: "", kw: "workspace rename archive description", mutates: true, out: Out::Other("{operationId,queued,entities:[Workspace],cursor}"), ex: ["gm workspace update launch --data '{\"archived\":true}'"]),
    meta!("workspace subscribe", git: "", kw: "repository workspace association subscription", mutates: true, out: Out::Other("{operationId,queued,entities:[Subscription],cursor}"), ex: ["gm workspace subscribe launch --repo REPO_ID"]),
    meta!("workspace unsubscribe", git: "", kw: "remove repository workspace subscription", mutates: true, out: Out::Other("{operationId,queued,entities:[],cursor}"), ex: ["gm workspace unsubscribe SUBSCRIPTION_ID"]),
    meta!("issue create", git: "", kw: "ticket task bug prd markdown acceptance offline stable id", mutates: true, out: Out::Other("{operationId,queued,entities:[Issue],cursor}; offline key is null until synchronized"), ex: ["gm issue create 'Ship search' --team ENG --type prd --description-file spec.md"]),
    meta!("issue list", git: "", kw: "tickets issues filter search status team workspace bounded", mutates: false, out: Out::Other("{issues:[Issue],total,truncated,offline,readinessAdvisory,cursor,cachedAt,next}"), ex: ["gm issue list --workspace launch --limit 20"]),
    meta!("issue ready", git: "", kw: "ready frontier agent unblocked available work dependency blockers", mutates: false, out: Out::Other("{issues:[Issue],total,truncated,offline,readinessAdvisory:true,cursor,cachedAt,next}; acquire an online claim before work"), ex: ["gm issue ready --limit 10"]),
    meta!("issue show", git: "", kw: "bounded context ancestors parent prd blockers dependents checkpoint evidence", mutates: false, out: Out::Other("{issue,ancestors,links,relatedIssues,notes,limitPerSection,truncated,ready,readinessAdvisory,cursor,cachedAt,offline}"), ex: ["gm issue show ENG-1 --limit 20"]),
    meta!("issue update", git: "", kw: "edit issue version optimistic status assignment acceptance labels", mutates: true, out: Out::Other("{operationId,queued,entities:[Issue],cursor}"), ex: ["gm issue update ENG-1 --data '{\"priority\":1}' --offline"]),
    meta!("issue link", git: "", kw: "dependency blocker related duplicate directed graph", mutates: true, out: Out::Other("{operationId,queued,entities:[Link],cursor}"), ex: ["gm issue link ENG-1 ENG-2 --kind blocks"]),
    meta!("issue unlink", git: "", kw: "remove dependency blocker relation", mutates: true, out: Out::Other("{operationId,queued,entities:[],cursor}"), ex: ["gm issue unlink LINK_ID"]),
    meta!("issue comment", git: "", kw: "durable markdown comment discussion", mutates: true, out: Out::Other("{operationId,queued,entities:[Comment],cursor}"), ex: ["gm issue comment ENG-1 'Investigating the failing build'"]),
    meta!("issue checkpoint", git: "", kw: "agent durable checkpoint progress decisions handoff resume", mutates: true, out: Out::Other("{operationId,queued,entities:[Comment],cursor}"), ex: ["gm issue checkpoint ENG-1 '@checkpoint.md'"]),
    meta!("issue evidence", git: "", kw: "verification evidence proof durable test result", mutates: true, out: Out::Other("{operationId,queued,entities:[Comment],cursor}"), ex: ["gm issue evidence ENG-1 'Verified with integration smoke'"]),
    meta!("issue batch", git: "", kw: "atomic graph dependency mutations offline batch json", mutates: true, out: Out::Other("{operationId,queued,entities:[Entity],cursor}; input array of {kind,id,expectedVersion?,data?}, max 100, canonical IDs"), ex: ["gm issue batch '@plan.json' --offline"]),
    meta!("issue next", git: "", kw: "next ready work pick claim agent graph autonomous loop lease", mutates: true, out: Out::Other("{claimed:{issueId,key,leaseToken,expiresAt}|null,context,blockerEvidence}; flags default from .gitmatrix (gm agent setup); gm keeps the lease token privately for this identity"), ex: ["gm issue next", "gm issue next --under CORE-4", "gm issue next --agent builder --team CORE"]),
    meta!("issue ask", git: "", kw: "ask person human question approval decision credential blocked waiting intervention park lease", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["GM_LEASE_TOKEN=… gm issue ask ENG-3 --kind question --prompt \"Which region should this deploy to?\"", "gm issue ask ENG-3 --kind decision --prompt \"Which store?\" --choice D1 --choice R2"]),
    meta!("issue resume", git: "", kw: "resume parked lease after answer continue", mutates: true, out: Out::Other("{cursor,events,results:[{id,leaseToken,expiresAt}]}; leaseToken is secret and is not cached"), ex: ["gm issue resume ENG-3"]),
    meta!("request list", git: "", kw: "requests needs you waiting on person questions approvals", mutates: false, out: Out::Other("{requests:[{id,issueId,kind,prompt,choices,secret,status,askedBy,routeTo,issue,asker,for}]}"), ex: ["gm request list"]),
    meta!("request answer", git: "", kw: "answer request approve reject choose decision credential secret", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["gm request answer 3f2c --answer eu-west", "gm request answer 3f2c --approve", "gm request answer 3f2c   # a credential: prompts for the value"]),
    meta!("request cancel", git: "", kw: "withdraw cancel request", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["gm request cancel 3f2c"]),
    meta!("issue handoff", git: "", kw: "hand off give transfer lease agent offer code", mutates: true, out: Out::Other("{cursor,events,results:[{id,offerCode,expiresAt}]}; offerCode is single-use"), ex: ["GM_LEASE_TOKEN=… gm issue handoff ENG-3 --to reviewer"]),
    meta!("issue withdraw", git: "", kw: "withdraw cancel handoff offer", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["GM_LEASE_TOKEN=… gm issue withdraw ENG-3"]),
    meta!("issue accept", git: "", kw: "accept handoff take over lease transfer code", mutates: true, out: Out::Other("{cursor,events,results:[{id,leaseToken,expiresAt}]}; leaseToken is secret and is not cached"), ex: ["gm issue accept ENG-3.4f…"]),
    meta!("issue revoke", git: "", kw: "revoke take back delegated claim sub lease subtree", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["GM_UNDER_TOKEN=… gm issue revoke ENG-12"]),
    meta!("issue claim", git: "", kw: "exclusive online claim fence agent lease token", mutates: true, out: Out::Other("{cursor,events,results:[{id,leaseToken,expiresAt}],serverTime}; gm keeps leaseToken privately for this identity, so lease commands need no token"), ex: ["gm issue claim ENG-1", "gm issue claim ENG-1 --agent build-agent", "GM_UNDER_TOKEN=… gm issue claim ENG-12 --agent sub --for reviewer"]),
    meta!("issue renew", git: "", kw: "lease renew online fencing token expiration", mutates: true, out: Out::Other("{cursor,events,results,serverTime}; token may appear only in claim/renew responses"), ex: ["gm issue renew ENG-1 --ttl 900"]),
    meta!("issue release", git: "", kw: "release exclusive fenced claim online", mutates: true, out: Out::Other("{cursor,events,results,serverTime}; lease token redacted"), ex: ["gm issue release ENG-1"]),
    meta!("issue complete", git: "", kw: "finish issue online fencing evidence done", mutates: true, out: Out::Other("{cursor,events,results,serverTime}; lease token redacted"), ex: ["gm issue complete ENG-1 --evidence '@verification.md'"]),
    meta!("status", git: "git status", kw: "what changed working copy modified files uncommitted dirty state where am i", mutates: false, out: Out::Typed(schema_of::<model::Status>), ex: ["gm status"]),
    meta!("log", git: "git log --oneline --graph", kw: "history list changes commits recent graph unpushed", mutates: false, out: Out::Typed(schema_of::<model::Log>), ex: ["gm log", "gm log -r all -n 20", "gm log -r trunk..@"]),
    meta!("show", git: "git show", kw: "inspect view change commit details patch", mutates: false, out: Out::Typed(schema_of::<model::Diff>), ex: ["gm show", "gm show @- --stat"]),
    meta!("diff", git: "git diff", kw: "difference patch compare changes lines edits", mutates: false, out: Out::Typed(schema_of::<model::Diff>), ex: ["gm diff", "gm diff --stat", "gm diff --from trunk --to @", "gm diff src/"]),
    meta!("describe", git: "git commit --amend -m (message only)", kw: "message rename reword edit description amend commit message title", mutates: true, out: OP, ex: ["gm describe -m \"Fix login redirect\"", "gm describe @- -m \"Better message\""]),
    meta!("new", git: "git switch -c / git stash / git merge --no-commit", kw: "start begin fresh empty change branch off checkout switch merge stash", mutates: true, out: OP, ex: ["gm new", "gm new trunk -m \"Try another approach\"", "gm new kxyz lmno"]),
    meta!("commit", git: "git commit -am", kw: "save checkpoint snapshot record work commit finish done message", mutates: true, out: OP, ex: ["gm commit -m \"Add retry to fetch\"", "gm commit -m \"Only the docs\" docs/"]),
    meta!("squash", git: "git commit --amend / git rebase -i fixup", kw: "amend fold fixup combine merge into parent meld absorb", mutates: true, out: OP, ex: ["gm squash", "gm squash -r kxyz --into lmno", "gm squash src/a.rs"]),
    meta!("split", git: "git add -p && git commit (partial)", kw: "separate break apart divide partial files into two changes", mutates: true, out: OP, ex: ["gm split -m \"Extract parser\" src/parser.rs"]),
    meta!("edit", git: "git checkout <commit> (to amend in place)", kw: "go to switch checkout revisit modify older change in place", mutates: true, out: OP, ex: ["gm edit kxyz"]),
    meta!("abandon", git: "git reset --hard HEAD~ / git rebase --onto (drop)", kw: "drop delete discard remove throw away change", mutates: true, out: OP, ex: ["gm abandon", "gm abandon kxyz"]),
    meta!("restore", git: "git restore / git checkout -- <path> / git reset --hard", kw: "discard revert file reset undo edits throw away changes clean", mutates: true, out: OP, ex: ["gm restore", "gm restore src/main.rs", "gm restore --from trunk Cargo.lock"]),
    meta!("rebase", git: "git rebase", kw: "move onto update base reparent stack", mutates: true, out: OP, ex: ["gm rebase", "gm rebase -s kxyz -d trunk", "gm rebase -r kxyz -d lmno"]),
    meta!("backout", git: "git revert", kw: "revert reverse undo a change inverse", mutates: true, out: OP, ex: ["gm backout -r kxyz"]),
    meta!("duplicate", git: "git cherry-pick", kw: "cherry pick copy apply change from elsewhere", mutates: true, out: OP, ex: ["gm duplicate kxyz", "gm duplicate kxyz -d trunk"]),
    meta!("undo", git: "git reflog + git reset (roughly)", kw: "undo revert last operation mistake oops go back", mutates: true, out: OP, ex: ["gm undo"]),
    meta!("op log", git: "git reflog", kw: "operation history undo log what did i do", mutates: false, out: Out::Typed(schema_of::<crate::commands::local::OpLog>), ex: ["gm op log -n 5"]),
    meta!("op restore", git: "git reset --hard <reflog entry>", kw: "restore operation go back to time travel", mutates: true, out: OP, ex: ["gm op restore 3fa2c1d09b7e"]),
    meta!("bookmark list", git: "git branch -a", kw: "branches list names refs", mutates: false, out: Out::Typed(schema_of::<crate::commands::local::Bookmarks>), ex: ["gm bookmark list"]),
    meta!("bookmark set", git: "git branch -f", kw: "create branch move branch name tag point", mutates: true, out: OP, ex: ["gm bookmark set feature-x", "gm bookmark set feature-x -r @-"]),
    meta!("bookmark delete", git: "git branch -D / git push --delete", kw: "delete remove branch", mutates: true, out: OP, ex: ["gm bookmark delete feature-x", "gm bookmark delete feature-x --remote"]),
    meta!("file show", git: "git show <rev>:<path>", kw: "cat read print file contents at revision", mutates: false, out: Out::Typed(schema_of::<crate::commands::local::FileShow>), ex: ["gm file show src/main.rs -r trunk"]),
    meta!("file list", git: "git ls-tree -r --name-only", kw: "ls files tree list paths", mutates: false, out: Out::Typed(schema_of::<crate::commands::local::FileList>), ex: ["gm file list", "gm file list src -r trunk"]),
    meta!("worktree add", git: "git worktree add --detach", kw: "parallel agent isolated checkout workspace create worktree include env ignored setup", mutates: true, out: Out::Typed(schema_of::<crate::commands::worktree::WorktreeResult>), ex: ["gm worktree add ../feature", "gm worktree add ../feature -r trunk --include"]),
    meta!("worktree list", git: "git worktree list", kw: "worktrees workspaces checkouts list parallel", mutates: false, out: Out::Typed(schema_of::<crate::commands::worktree::WorktreeResult>), ex: ["gm worktree list"]),
    meta!("worktree remove", git: "git worktree remove", kw: "worktree workspace checkout delete remove cleanup", mutates: true, out: Out::Typed(schema_of::<crate::commands::worktree::WorktreeResult>), ex: ["gm worktree remove ../feature", "gm worktree remove ../feature --force"]),
    meta!("init", git: "git init (then adopt)", kw: "initialize start adopt existing repository setup", mutates: true, out: OP, ex: ["gm init"]),
    meta!("clone", git: "git clone", kw: "download copy checkout repository get code progress transfer quiet", mutates: true, out: Out::Typed(schema_of::<crate::commands::network::Cloned>), ex: ["gm clone orbit/engine", "gm clone orbit/engine ./engine", "gm clone orbit/engine --quiet"]),
    meta!("fetch", git: "git fetch", kw: "download remote update refresh get latest", mutates: true, out: Out::Other("{trunk:{before,after}|null,updated_refs:[name]}"), ex: ["gm fetch"]),
    meta!("sync", git: "git pull --rebase", kw: "pull update rebase onto latest trunk catch up refresh", mutates: true, out: OP, ex: ["gm sync"]),
    meta!("push", git: "git push", kw: "upload publish land ship merge deploy send pull request pr", mutates: true, out: Out::Typed(schema_of::<crate::commands::network::Pushed>), ex: ["gm push", "gm push --sync", "gm push -b feature-x"]),
    meta!("auth login", git: "git credential approve / ssh-add", kw: "login sign in authenticate token persona credentials ssh key agent 1password", mutates: true, out: Out::Other("{server,method,user:{slug},key?,scope?,sessionExpiresAt?}"), ex: ["gm auth login --ssh", "gm auth login --ssh --key ~/.ssh/id_ed25519", "gm auth login --persona jun", "gm auth login --token gmx_..."]),
    meta!("auth ssh-key add", git: "(GitHub: Settings > SSH keys)", kw: "add register upload ssh public key agent 1password", mutates: true, out: Out::Other("SshKey {id,title,type,fingerprint,scope}"), ex: ["gm auth ssh-key add", "gm auth ssh-key add --key SHA256:abc... --title Laptop"]),
    meta!("auth ssh-key list", git: "ssh-add -l", kw: "list ssh keys registered agent local fingerprints", mutates: false, out: Out::Other("{registered:[SshKey],local:[{fingerprint,type,comment,source,registered}],unreachableAgents}"), ex: ["gm auth ssh-key list"]),
    meta!("auth ssh-key remove", git: "", kw: "remove delete unregister revoke ssh key", mutates: true, out: Out::Other("{removed}"), ex: ["gm auth ssh-key remove SHA256:abc..."]),
    meta!("auth git-credential", git: "git credential-<helper>", kw: "git credential helper plain git https password ssh session", mutates: false, out: Out::Other("git credential lines (username=, password=) on stdout"), ex: ["git config --global credential.https://git.example.com.helper '!gm auth git-credential'"]),
    meta!("auth status", git: "", kw: "whoami who am i signed in user account", mutates: false, out: Out::Other("{server,user|null}"), ex: ["gm auth status"]),
    meta!("auth logout", git: "git credential reject", kw: "logout sign out forget token", mutates: true, out: Out::Other("{server,signed_out}"), ex: ["gm auth logout"]),
    meta!("repo list", git: "", kw: "repositories list remote server projects", mutates: false, out: Out::Other("{repos:[RepoSummary]}"), ex: ["gm repo list"]),
    meta!("repo create", git: "", kw: "new repository create remote server import", mutates: true, out: Out::Other("RepoSummary"), ex: ["gm repo create demo", "gm repo create engine --owner orbit --import https://github.com/lukeed/clsx"]),
    meta!("repo view", git: "git remote show origin", kw: "repository info details branches clone url", mutates: false, out: Out::Other("RepoDetail"), ex: ["gm repo view", "gm repo view orbit/engine"]),
    meta!("repo delete", git: "", kw: "delete remove repository server", mutates: true, out: Out::Other("{deleted}"), ex: ["gm repo delete jun/demo --yes"]),
    meta!("repo mirror show", git: "", kw: "mirror backup github sync status push copy replicate", mutates: false, out: Out::Other("{mirror:RepoMirror|null}"), ex: ["gm repo mirror show"]),
    meta!("repo mirror set", git: "git remote add --mirror=push", kw: "mirror backup github push replicate configure token", mutates: true, out: Out::Other("{mirror:RepoMirror}"), ex: ["gh auth token | gm repo mirror set https://github.com/owner/name.git --token-stdin", "gm repo mirror set --prune"]),
    meta!("repo mirror sync", git: "git push --mirror", kw: "mirror sync now backup github push", mutates: true, out: Out::Other("{message,updates,mirror}"), ex: ["gm repo mirror sync"]),
    meta!("repo mirror remove", git: "", kw: "mirror stop remove backup", mutates: true, out: Out::Other("{removed}"), ex: ["gm repo mirror remove"]),
    meta!("release list", git: "", kw: "release notes changelog daily code updates UTC tags ai generated status", mutates: false, out: Out::Other("ReleaseNotesIndex {status:{state:'disabled'|'idle'|'generating'|'ready'|'failed',generatedAt:string|null},releases:[{name,kind:'daily'|'tag',toOid,fromTag:string|null,lastCommitAt,updatedAt,entries}]}; daily updates appear first, newest first; '@day:YYYY-MM-DD' groups default-branch first-parent history by Git committer date (UTC); tags are optional named snapshots. lastCommitAt is Git commit time, not deployment evidence."), ex: ["gm release list --repo orbit/engine"]),
    meta!("release notes", git: "", kw: "release notes changelog daily code updates ai summary features fixes tag UTC", mutates: false, out: Out::Other("ReleaseNotesRelease {release:{name,kind:'daily'|'tag',toOid,fromTag,fromOid,truncated,lastCommitAt,updatedAt,entries,intro:string|null,introModel},entries:[{id,release,releaseKind:'daily'|'tag',kind:'issue'|'commit',category:'feature'|'fix'|'improvement'|'internal',title,summary,issue:{trackerOwner,id,key,type,team:{id,key}}|null,labels,workspaceIds,commits,changes:[{kind,name,path,summary}],lastCommitAt,model,updatedAt}]}. Defaults to the newest daily update with visible entries, or the newest daily update if all are empty; only when no daily updates exist, selects the newest tag with entries or the first tag. day:YYYY-MM-DD selects a UTC date, other names select literal tags. lastCommitAt is the latest Git commit time in the group, not tracker completion or deployment time. Entries from trackers you can't read, and intros they shaped, are omitted."), ex: ["gm release notes", "gm release notes v1.2.0 --repo orbit/engine", "gm release notes day:2026-10-02 --internal -o json"]),
    meta!("release feed", git: "", kw: "release notes changelog daily code updates tags team organization org wide facets filter week since until type kind label workspace repo", mutates: false, out: Out::Other("ReleaseFeed {owner:{slug,displayName},query:{filters:[{key,value,negated}],words,unknown},entries:[ReleaseNoteEntry & {repos:[{owner,name,releases}]}],truncated,facets:{teams,repos,workspaces,categories,labels,releases:[{value,label,count}]}}; deduplicated per issue, newest Git commit time first; defaults to daily updates. kind:tag selects named snapshots; release:day:YYYY-MM-DD selects a UTC daily update. Explicit kind filters or positive release filters opt into matching daily/tag groups. Internal entries excluded unless --internal or a type: filter. This is code history, not deployment evidence."), ex: ["gm release feed --owner orbit", "gm release feed --team CORE since:30d", "gm release feed kind:tag repo:engine -o json", "gm release feed release:day:2026-10-02"]),
    meta!("semantic list", git: "", kw: "semantic syntax changes feed history symbols functions parameters calls arguments imports sections links elements attributes properties rules declarations text renamed signatures language coverage source", mutates: false, out: Out::Other("SemanticFeedResponse {version:1,ref,head:string|null,entries:[{id,kind,language,entity,name,previousName:string|null,scope,summary,evidence:'syntax',before:SemanticSource|null,after:SemanticSource|null,commit:{oid,parent:string|null,message,authorName,authoredAt},links:{commit,before:string|null,after:string|null}}],nextCursor:string|null,coverage:[{commit,path,status:'analyzed'|'unsupported'|'parse_error'|'too_large'|'binary',diagnostics:[{message,from,to}]}]}; SemanticSource {path,start:{line,column},end:{line,column},text,truncated,tokens:[{from,to,className}]}. Empty entries may still have nextCursor: continue with the same filters until null. Syntax evidence does not imply type resolution or author intent."), ex: ["gm semantic list --repo orbit/engine -o json", "gm semantic list --ref main --language rust --kind symbol.signature_changed", "gm semantic list --path src/main.ts --cursor '<nextCursor>'"]),
    meta!("runs list", git: "", kw: "ci cd pipeline builds checks runs status list recent tests", mutates: false, out: Out::Other("{runs:[CiRunSummary],runner}"), ex: ["gm runs list", "gm runs list -R orbit/engine"]),
    meta!("runs show", git: "", kw: "ci run details jobs steps status result build", mutates: false, out: Out::Other("CiRunDetail {number,status,commit,ref,jobs:[{name,status,steps}]}"), ex: ["gm runs show", "gm runs show 12"]),
    meta!("runs logs", git: "", kw: "ci output logs build failure why did it fail test output", mutates: false, out: Out::Other("{run,jobs:[{job,status,done,log}]}"), ex: ["gm runs logs", "gm runs logs 12 --job test", "gm runs logs 12 -f"]),
    meta!("runs wait", git: "", kw: "ci wait block until build finishes tests pass green check result after push", mutates: false, out: Out::Other("CiRunDetail; exits 4 (code run_failed) when the run fails"), ex: ["gm runs wait", "gm push && gm runs wait", "gm runs wait 12", "gm runs wait --commit @-"]),
    meta!("runs start", git: "", kw: "ci trigger start run build manually dispatch", mutates: true, out: Out::Other("{number}"), ex: ["gm runs start", "gm runs start --ref feature-x"]),
    meta!("runs cancel", git: "", kw: "ci cancel stop abort run build", mutates: true, out: Out::Other("{cancelled}"), ex: ["gm runs cancel 12"]),
    meta!("runs rerun", git: "", kw: "ci retry rerun again restart build flaky", mutates: true, out: Out::Other("{number}"), ex: ["gm runs rerun 12"]),
    meta!("runner", git: "", kw: "ci runner agent worker execute jobs locally self-hosted run pipelines dev", mutates: false, out: Out::Other("{jobs:[{repo,run,job,status}]} (one JSON line per job while running)"), ex: ["gm runner", "gm runner --once", "gm runner -R orbit/engine -v"]),
    meta!("secret list", git: "", kw: "ci secrets environment variables credentials list", mutates: false, out: Out::Other("{secrets:[{name,updatedAt}]}"), ex: ["gm secret list"]),
    meta!("secret set", git: "", kw: "ci add secret token credential environment variable", mutates: true, out: Out::Other("{set}"), ex: ["gm secret set NPM_TOKEN --value xyz", "echo $TOKEN | gm secret set CLOUDFLARE_API_TOKEN"]),
    meta!("ask", git: "", kw: "ask question assistant ai explain why how deepwiki chat codebase knowledge issues ci packages agent query", mutates: false, out: Out::Other("{chatId,url,repo,answer,tools:[label],next}; text output streams the answer; --write lets it change things"), ex: ["gm ask \"Why did run 44 fail?\"", "gm ask -R matrixorg/gitmatrix \"Where is the tracker's readiness computed?\"", "gm ask --chat CHAT_ID \"And who changed it last?\"", "gm ask --write \"File a bug for the flaky clone test in CORE\""]),
    meta!("assistant list", git: "", kw: "assistant conversations chats history", mutates: false, out: Out::Other("{chats:[{id,title,source,createdAt,updatedAt}]}"), ex: ["gm assistant list"]),
    meta!("assistant show", git: "", kw: "assistant conversation transcript messages", mutates: false, out: Out::Other("{id,title,source,messages:[{role,text,tools}]}"), ex: ["gm assistant show CHAT_ID"]),
    meta!("assistant delete", git: "", kw: "assistant delete conversation", mutates: true, out: Out::Other("{deleted}"), ex: ["gm assistant delete CHAT_ID"]),
    meta!("agent setup", git: "", kw: "configure set up agent harness claude codex cursor AGENTS.md skills instructions identity token profile scope gm issue next defaults .gitmatrix", mutates: true, out: Out::Other("{dryRun,agent,harness,model,tags,scope,identity:{id,name,accountable,created,token,profile}|null,files:[{path,status}],next}; --check: {upToDate,files} or error code stale (exit 4)"), ex: ["gm agent setup", "gm agent setup --harness codex --model gpt-5 --tag rust", "gm agent setup --under CORE-4", "gm agent setup --check"]),
    meta!("agent list", git: "", kw: "agents identities accountable bots list capabilities selection owner", mutates: false, out: Out::Other("{agents:[{id,name,description,accountable,createdAt,revokedAt,tokens,capabilities,capabilitiesUpdatedAt}]}"), ex: ["gm agent list", "gm agent list --owner orbit"]),
    meta!("agent detect", git: "", kw: "agent local capabilities environment harness model skills tags detect", mutates: false, out: Out::Other("{version:1,harness,model,environment:{os,arch,runtime,cpuCount,memoryBytes},tags,skills:[{name,description,source}]}"), ex: ["gm agent detect", "gm agent detect --model explicit-model --tag rust"]),
    meta!("agent configure", git: "", kw: "agent create update refresh configure profile capabilities model harness skills tags", mutates: true, out: Out::Other("{agent:{id,name,description,accountable,createdAt,revokedAt,tokens,capabilities,capabilitiesUpdatedAt}}"), ex: ["gm agent configure builder --tag rust --skill review", "gm agent configure", "gm agent configure builder --clear-model --clear-tags --clear-skills --dry-run"]),
    meta!("agent show", git: "", kw: "agent self profile capabilities model harness skills tags show", mutates: false, out: Out::Other("{agent:{id,name,description,accountable,createdAt,revokedAt,tokens,capabilities,capabilitiesUpdatedAt}}"), ex: ["gm agent show builder", "gm agent show"]),
    meta!("agent create", git: "", kw: "create agent identity bot accountable", mutates: true, out: Out::Other("{agent:{id,name,description,accountable,createdAt,revokedAt,tokens,capabilities,capabilitiesUpdatedAt}}"), ex: ["gm agent create builder --description \"Works the CORE graph\""]),
    meta!("agent token", git: "", kw: "agent token credential GM_TOKEN sign in mint", mutates: true, out: Out::Other("{agent,token:{id,name,scope,lastFour,secret}}; secret is shown once"), ex: ["gm agent token builder"]),
    meta!("agent revoke", git: "", kw: "revoke disable agent tokens", mutates: true, out: Out::Other("{revoked}"), ex: ["gm agent revoke builder"]),
    meta!("secret delete", git: "", kw: "ci remove secret", mutates: true, out: Out::Other("{deleted}"), ex: ["gm secret delete NPM_TOKEN"]),
    meta!("pkg list", git: "", kw: "packages artifacts registry npm docker images crates wheels list published owner", mutates: false, out: Out::Other("OwnerPackages {owner,packages:[{format,name,latest,versions,publishes24h,sources}],feeds}"), ex: ["gm pkg list", "gm pkg list -O orbit"]),
    meta!("pkg show", git: "", kw: "package details latest version tags sources install", mutates: false, out: Out::Other("PackageDetail {package,tags,sources,totals,actions}"), ex: ["gm pkg show npm/@orbit/web", "gm pkg show oci/engine"]),
    meta!("pkg versions", git: "", kw: "package versions history query filter builds published from branch commit run what did ci publish", mutates: false, out: Out::Other("PublishPage {total,rows:[{version,status,repo,ref,commit,runNumber,at,tags}],facets,histogram}"), ex: ["gm pkg versions npm/@orbit/web", "gm pkg versions oci/engine -q \"branch:main since:24h\"", "gm pkg versions npm/@orbit/web -q \"commit:4f2a1b\""]),
    meta!("pkg delete", git: "", kw: "delete unpublish remove package versions cleanup housekeeping prune old builds", mutates: true, out: Out::Other("{done,failed:[{version,error}],remaining}"), ex: ["gm pkg delete npm/@orbit/web 1.0.0-pr.12", "gm pkg delete oci/engine -q \"branch:feature/* since:90d\" --dry-run"]),
    meta!("pkg yank", git: "", kw: "yank cargo pypi version bad release", mutates: true, out: Out::Other("{done,failed,remaining}"), ex: ["gm pkg yank cargo/orbit-core 0.4.1 --reason \"breaks serde\""]),
    meta!("pkg restore", git: "", kw: "unyank undeprecate restore version", mutates: true, out: Out::Other("{done,failed,remaining}"), ex: ["gm pkg restore cargo/orbit-core 0.4.1"]),
    meta!("pkg deprecate", git: "", kw: "npm deprecate version message", mutates: true, out: Out::Other("{done,failed,remaining}"), ex: ["gm pkg deprecate npm/@orbit/web 1.x --reason \"Use 2.x\""]),
    meta!("pkg tag", git: "", kw: "dist-tag docker tag promote release stable latest", mutates: true, out: Out::Other("{done,failed}"), ex: ["gm pkg tag npm/@orbit/web 2.4.0 stable", "gm pkg tag oci/engine sha-4f2a1b7 prod"]),
    meta!("pkg sources", git: "", kw: "package sources which repositories publish provenance", mutates: false, out: Out::Other("{sources:[{repo,publishes,lastPublishedAt}]}"), ex: ["gm pkg sources npm/@orbit/web"]),
    meta!("pkg grant", git: "", kw: "allow repository publish package permission source ci", mutates: true, out: Out::Other("{sources}"), ex: ["gm pkg grant npm/@orbit/web orbit/website"]),
    meta!("pkg revoke", git: "", kw: "remove repository publish permission source", mutates: true, out: Out::Other("{sources}"), ex: ["gm pkg revoke npm/@orbit/web orbit/website"]),
    meta!("pkg published", git: "", kw: "what did this run commit build publish artifacts outputs ci", mutates: false, out: Out::Other("{rows:[{format,package,feed,version,status}]}"), ex: ["gm pkg published", "gm pkg published --run 42", "gm pkg published --commit $(git rev-parse HEAD)"]),
    meta!("pkg upload", git: "", kw: "upload file artifact generic binary tarball release asset ci", mutates: true, out: Out::Other("{repo,path,downloadUri,size,checksums}"), ex: ["gm pkg upload dist/app.tgz app/1.4.0", "gm pkg upload build.zip app/$GITMATRIX_COMMIT/build.zip"]),
    meta!("pkg download", git: "", kw: "download artifact binary file generic package checksum fetch save", mutates: true, out: Out::Other("{path,version,sha256,size,dry_run,installed}"), ex: ["gm pkg download gm/latest/linux-x86_64/gm -O orbit --dest ./gm", "gm pkg download app/1.4.0/app.tgz"]),
    meta!("pkg install", git: "", kw: "install update upgrade cli executable binary unix artifact local bin", mutates: true, out: Out::Other("{path,version,sha256,size,dry_run,installed,platform}"), ex: ["gm pkg install gm -O orbit", "gm pkg install gm -O orbit --force", "gm pkg install gm -O orbit --version <commit> --bin-dir ./bin"]),
    meta!("pkg setup", git: "", kw: "configure npm docker pip cargo registry login npmrc credentials machine", mutates: true, out: Out::Other("{owner,npmrc,docker,pip,cargo,goproxy,maven,helm,generic}"), ex: ["gm pkg setup", "gm pkg setup -O orbit --write npm,docker"]),
    meta!("api", git: "", kw: "raw http api request endpoint json", mutates: true, out: Out::Other("the API's JSON response"), ex: ["gm api GET /repos", "gm api POST /repos -d '{\"owner\":\"jun\",\"name\":\"x\",\"visibility\":\"private\"}'"]),
    meta!("cli search", git: "", kw: "find command help discover how do i", mutates: false, out: Out::Typed(schema_of::<Vec<Hit>>), ex: ["gm cli search \"undo my last commit\""]),
    meta!("cli guide", git: "", kw: "workflow guide tutorial how to use agents", mutates: false, out: Out::Other("markdown text"), ex: ["gm cli guide"]),
    meta!("cli commands", git: "", kw: "manifest all commands list reference", mutates: false, out: Out::Other("{commands:[ManifestEntry]}"), ex: ["gm cli commands"]),
    meta!("schema", git: "", kw: "schema inputs outputs json shape arguments", mutates: false, out: Out::Other("{command,usage,arguments,options,output}"), ex: ["gm schema push", "gm schema bookmark set"]),
];

pub fn find(path: &str) -> Option<&'static Meta> {
    COMMANDS.iter().find(|m| m.path == path)
}

#[derive(Serialize, JsonSchema, Clone)]
pub struct Param {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short: Option<char>,
    pub required: bool,
    pub multiple: bool,
    /// Takes no value (a switch).
    pub flag: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
    pub description: String,
}

#[derive(Serialize, JsonSchema, Clone)]
pub struct Entry {
    pub command: String,
    pub summary: String,
    pub usage: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub git: String,
    pub mutates: bool,
    pub arguments: Vec<Param>,
    pub options: Vec<Param>,
    pub examples: Vec<String>,
}

fn param(arg: &clap::Arg) -> Param {
    let flag = matches!(
        arg.get_action(),
        clap::ArgAction::SetTrue | clap::ArgAction::SetFalse | clap::ArgAction::Count
    );
    Param {
        name: arg
            .get_long()
            .map(|l| format!("--{l}"))
            .unwrap_or_else(|| arg.get_id().to_string()),
        short: arg.get_short(),
        required: arg.is_required_set(),
        multiple: matches!(arg.get_action(), clap::ArgAction::Append)
            || arg
                .get_num_args()
                .map(|n| n.max_values() > 1)
                .unwrap_or(false),
        flag,
        default: if flag {
            None
        } else {
            arg.get_default_values()
                .first()
                .map(|v| v.to_string_lossy().into_owned())
        },
        choices: if flag {
            Vec::new()
        } else {
            arg.get_possible_values()
                .iter()
                .map(|v| v.get_name().to_string())
                .collect()
        },
        description: arg.get_help().map(|h| h.to_string()).unwrap_or_default(),
    }
}

/// Every leaf command, in definition order.
pub fn manifest() -> Vec<Entry> {
    fn walk(cmd: &clap::Command, prefix: &str, inherited: &[&clap::Arg], out: &mut Vec<Entry>) {
        let mut scoped = inherited.to_vec();
        if !prefix.is_empty() {
            for arg in cmd.get_arguments().filter(|arg| arg.is_global_set()) {
                if !scoped
                    .iter()
                    .any(|previous| previous.get_id() == arg.get_id())
                {
                    scoped.push(arg);
                }
            }
        }
        for sub in cmd.get_subcommands() {
            let path = if prefix.is_empty() {
                sub.get_name().to_string()
            } else {
                format!("{prefix} {}", sub.get_name())
            };
            if sub.has_subcommands() {
                walk(sub, &path, &scoped, out);
                continue;
            }
            let meta = find(&path);
            let mut usage_cmd = sub.clone().bin_name(format!("gm {path}"));
            let mut args: Vec<&clap::Arg> = sub
                .get_arguments()
                .filter(|arg| arg.get_id() != "help")
                .collect();
            for arg in &scoped {
                if !args.iter().any(|own| own.get_id() == arg.get_id()) {
                    usage_cmd = usage_cmd.arg((*arg).clone());
                    args.push(arg);
                }
            }
            let usage = usage_cmd
                .render_usage()
                .to_string()
                .trim_start_matches("Usage: ")
                .to_string();
            out.push(Entry {
                command: format!("gm {path}"),
                summary: sub.get_about().map(|s| s.to_string()).unwrap_or_default(),
                usage,
                aliases: sub.get_visible_aliases().map(str::to_string).collect(),
                git: meta.map(|m| m.git.to_string()).unwrap_or_default(),
                mutates: meta.map(|m| m.mutates).unwrap_or(false),
                arguments: args
                    .iter()
                    .filter(|a| a.is_positional())
                    .map(|a| param(a))
                    .collect(),
                options: args
                    .iter()
                    .filter(|a| !a.is_positional())
                    .map(|a| param(a))
                    .collect(),
                examples: meta
                    .map(|m| m.examples.iter().map(|e| e.to_string()).collect())
                    .unwrap_or_default(),
            });
        }
    }
    let mut out = Vec::new();
    walk(&crate::cli::Cli::command(), "", &[], &mut out);
    out
}

/// Global flags every command accepts.
pub fn global_options() -> Vec<Param> {
    crate::cli::Cli::command()
        .get_arguments()
        .filter(|a| a.is_global_set())
        .map(param)
        .collect()
}

// ---- search --------------------------------------------------------------

fn stem(word: &str) -> String {
    let w = word.to_lowercase();
    for suffix in ["ing", "ed", "es", "s"] {
        if w.len() > suffix.len() + 2 && w.ends_with(suffix) {
            return w[..w.len() - suffix.len()].to_string();
        }
    }
    w
}

fn tokens(text: &str) -> Vec<String> {
    const STOP: &[&str] = &[
        "the", "a", "an", "to", "my", "i", "of", "in", "on", "and", "or", "for", "it", "is", "do",
        "how", "with", "from", "into", "this", "that", "all", "me", "want",
    ];
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && !STOP.contains(&w.to_lowercase().as_str()))
        .map(stem)
        .collect()
}

#[derive(Serialize, JsonSchema)]
pub struct Hit {
    pub command: String,
    pub summary: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub git: String,
}

#[derive(Serialize)]
#[serde(transparent)]
pub struct Hits(pub Vec<Hit>);

impl Render for Hits {
    fn text(&self) -> String {
        self.0
            .iter()
            .map(|h| {
                let git = if h.git.is_empty() {
                    String::new()
                } else {
                    format!("  (git: {})", h.git)
                };
                format!("{:<22} {}{}", h.command, h.summary, git)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Rank commands for a plain-language query (BM25-style weights over the
/// command name, keywords, git equivalent and description).
pub fn search(query: &str) -> Vec<Hit> {
    let entries = manifest();
    let docs: Vec<(Vec<String>, Vec<String>, Vec<String>)> = entries
        .iter()
        .map(|e| {
            let path = e.command.trim_start_matches("gm ");
            let meta = find(path);
            let mut name = tokens(path);
            name.extend(e.aliases.iter().map(|a| stem(a)));
            let keywords = tokens(&format!(
                "{} {}",
                meta.map(|m| m.keywords).unwrap_or(""),
                meta.map(|m| m.git).unwrap_or("")
            ));
            let body = tokens(&format!(
                "{} {}",
                e.summary,
                e.options
                    .iter()
                    .map(|o| o.description.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            ));
            (name, keywords, body)
        })
        .collect();
    let n = docs.len() as f64;
    let query = tokens(query);
    let mut scored: Vec<(f64, usize)> = docs
        .iter()
        .enumerate()
        .map(|(i, (name, keywords, body))| {
            let mut score = 0.0;
            for term in &query {
                let df = docs
                    .iter()
                    .filter(|(a, b, c)| a.contains(term) || b.contains(term) || c.contains(term))
                    .count() as f64;
                if df == 0.0 {
                    continue;
                }
                let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                let tf = 3.0 * name.iter().filter(|t| *t == term).count() as f64
                    + 2.0 * keywords.iter().filter(|t| *t == term).count().min(2) as f64
                    + body.iter().filter(|t| *t == term).count().min(2) as f64;
                score += idf * tf / (tf + 1.2);
            }
            (score, i)
        })
        .filter(|(score, _)| *score > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(5)
        .map(|(_, i)| Hit {
            command: entries[i].command.clone(),
            summary: entries[i].summary.clone(),
            git: entries[i].git.clone(),
        })
        .collect()
}

// ---- schema ----------------------------------------------------------------

#[derive(Serialize)]
pub struct Schema {
    #[serde(flatten)]
    pub entry: Entry,
    pub global_options: Vec<Param>,
    pub output: Value,
}

impl Render for Schema {
    fn text(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }
}

fn schema_of<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap_or(Value::Null)
}

pub fn schema(words: &[String]) -> Result<Schema> {
    let mut path = words.join(" ");
    path = path.trim_start_matches("gm ").to_string();
    let entries = manifest();
    let entry = entries
        .iter()
        .find(|e| {
            e.command == format!("gm {path}")
                || e.aliases
                    .iter()
                    .any(|a| format!("gm {a}") == format!("gm {path}"))
        })
        .cloned()
        .ok_or_else(|| {
            GmError::not_found("unknown_command", format!("No command `gm {path}`."))
                .hint(format!("Try `gm cli search \"{path}\"`."))
        })?;
    let out = find(entry.command.trim_start_matches("gm "))
        .map(|m| m.out)
        .unwrap_or(Out::Other("unspecified"));
    let output = match out {
        Out::Typed(schema) => schema(),
        Out::Other(shape) => json!({ "description": shape }),
    };
    Ok(Schema {
        entry,
        global_options: global_options(),
        output,
    })
}

// ---- guide ----------------------------------------------------------------

pub const GUIDE: &str = r#"# gm: working with Gitmatrix

gm is change-based (like jj), not commit-and-stage based (like git).

## The model
- Your files are always in a change called `@` (the working copy). Workspace
  commands snapshot the files on disk into `@` first. There is no staging
  area and nothing is ever "uncommitted".
- Every change has a **change id** (letters k-z, e.g. `kxmqvtyl`) that stays
  the same when the change is rewritten. Commit ids (hex) change on every
  rewrite. Prefer change ids when you refer to changes.
- Rewriting a change automatically rebases everything on top of it.
- Workspace changes are operations; `gm undo` reverses the last one (repeat
  to go further back). Worktree creation/removal is not undoable.
- `trunk` is the server's main line. Changes in trunk are immutable.
- There are no pull requests. `gm push` lands your changes on trunk.

## The loop (commit early, commit often)
    gm status                      # where am I, what changed
    # ...edit files...
    gm commit -m "Add retry to fetch"   # describe @, start a fresh @ on top
    # ...edit more...
    gm commit -m "Cover retry in tests"
    gm push --sync                 # rebase onto latest trunk, then land it

`gm commit` is cheap: make one per logical step. To fix an earlier step,
edit files and run `gm squash --into <change id>`, or `gm edit <change id>`
then `gm new` to come back on top.

## Revisions
`@` working copy · `@-` its parent · `@--` grandparent · `trunk` · a change id
prefix (`kxmq`) · a commit id prefix (`1a2b3c`) · a bookmark name.
Ranges for `gm log -r`: `trunk..@`, `all`.

## Everyday commands (git equivalent)
- `gm status` (git status) · `gm diff` (git diff) · `gm log` (git log)
- `gm commit -m` (git commit -am) · `gm describe -m` (amend the message)
- `gm new` (start a fresh change; also how you "stash") · `gm edit <rev>`
- `gm squash` (amend/fixup) · `gm split -m msg <paths>` (partial commit)
- `gm restore [paths]` (discard edits) · `gm abandon <rev>` (drop a change)
- `gm rebase -d trunk` · `gm backout -r <rev>` (revert) · `gm duplicate <rev>` (cherry-pick)
- `gm sync` (pull --rebase) · `gm push` (land on trunk) · `gm push -b name` (push a bookmark)
- `gm undo` · `gm op log`

## Worktrees
    gm worktree add ../feature --include  # isolated @ on the current snapshot
    gm worktree add ../clean -r trunk     # start from trunk instead
    gm -C ../feature status
    gm worktree list
    gm worktree remove ../feature
Each worktree has its own files, @ and undo log; objects and bookmarks are shared.
`--include` copies ignored, untracked regular files matching the source root's
`.worktreeinclude` (gitignore syntax). The checkout's agent
(`.gitmatrix/agent.local.yml`, no credentials) is always copied, so work in a
worktree keeps its agent. Symlinks/overwrites are rejected. Run
dependency installation yourself in the new checkout; do not copy node_modules.
`add --dry-run` previews the stored @ and include plan without snapshotting.
Removal refuses dirty/ignored files unless --force, and always refuses locks,
the main checkout and your current checkout. Recorded gm history is archived;
unsnapshotted edits and ignored files are discarded with --force.

## Distributed tracker (no Git repository required)
    gm tracker use orbit
    gm team create ENG --name Engineering
    gm issue create 'Fix search' --team ENG
    gm issue ready --limit 10
    gm issue show ENG-1 --limit 20
    gm issue claim ENG-1 --agent my-agent
    gm issue checkpoint ENG-1 'Implemented; next: verify'
    gm issue complete ENG-1 --evidence 'Smoke verified'  # GM_LEASE_TOKEN required
Explicit `--offline` queues durable SQLite edits; online commands never mask errors.
`gm tracker sync` replays in order, retaining uncertain acknowledgements by operation ID.
`gm tracker conflicts` preserves local/remote data; resolve the head explicitly using
`gm tracker resolve OPERATION --strategy accept-server|reapply-local`.
Offline readiness is advisory, never a lease. Lease operations require online access.
Tracker writes are not restored by `gm undo`. `gm schema issue batch` describes atomic
graph input. `gm tracker status` exposes private replica paths for credential recovery.

## Working through a graph (agents)
An agent has its own identity, accountable to a person. `gm agent setup` (run
once per checkout, again to update) creates it and keeps its token, publishes
its advisory profile, writes the instructions and skill for its harness, and
records scope and lease length in .gitmatrix/ (agents.yml shared,
agent.local.yml per checkout). When the harness drives gm there, gm acts as
the agent and keeps its lease tokens:
    gm issue next                                  # pick + claim atomically, in scope
    gm issue checkpoint CORE-5 'Done X; next Y'    # as you go; gm issue renew CORE-5
    gm issue ask CORE-5 --kind question --prompt 'Which region?'  # parks the lease
    gm issue resume CORE-5                         # after a person answers
    gm issue complete CORE-5 --evidence 'Shipped in <commit>, CI run #N green'
Elsewhere, `gm agent create`/`token` with GM_TOKEN, `--agent`, and GM_LEASE_TOKEN
do the same by hand.
Ready means todo, unblocked, no open sub-issues, no one else's lease above, and not
waiting on a person. `next` takes priority, then whatever unblocks the most work,
then the oldest; it skips PRDs and other people's assignments. A lease covers its
subtree: claim a parent to own it, then delegate inside it with that lease's token
(`--under-token`, or GM_UNDER_TOKEN) and `--for <agent>`; `gm issue revoke` takes a
delegated claim back. `gm issue handoff` gives your lease to another agent as a
single-use code (`gm issue accept CODE`). Questions, approvals, decisions and
credentials go to a person: they answer on the web's Needs you page or with
`gm request answer`; a credential is stored as its secret, never in the tracker.
Repeatedly released work asks its accountable person what to do differently.

## Asking the assistant
`gm ask "<question>"` asks Gitmatrix's assistant, which reads code (and the
knowledge graph), issues, CI runs and packages with your permissions and answers
with links. Inside a checkout it knows the repository; `-R owner/name` otherwise.
It's read-only unless `--write`; follow up with `--chat <id>`. Conversations are
shared with the web (`gm assistant list`, or open the printed link).

## CI
Pushes run the pipeline in `.gitmatrix/ci.yml` (jobs, steps, `needs`, `if`,
`secrets`). Check your work landed green:
    gm push && gm runs wait        # blocks; exit 0 = passed, 4 = failed
    gm runs logs --job test        # why it failed
`gm runs list|show|start|cancel|rerun`, `gm secret set NAME`. Against the dev
server, jobs run on your machine: keep `gm runner` going next to `vp dev`.
Under load a push may share a run with later pushes (it's "covered" by the newer
run); `gm runs wait` follows the covering run, so its verdict includes your commit.
Starting a commit that's already running returns that run; jobs with `paths:` skip
themselves when those paths are unchanged since they last passed.

## Packages
CI jobs publish with their own credential: `npm publish`, `docker push
$GITMATRIX_IMAGE_PREFIX/app:tag`, `twine upload`, `cargo publish --registry
gitmatrix` and `gm pkg upload` need no setup, and each publish records its
repository, branch, commit and run. Packages are `<format>/<name>`:
    gm pkg list                                      # this owner's packages
    gm pkg versions npm/@orbit/web -q "branch:main since:24h"
    gm pkg published --run 42                        # what a run published
    gm pkg delete oci/engine -q "branch:feature/* since:90d" --dry-run
    gm pkg grant npm/@orbit/web orbit/website        # let a repo publish it
    gm pkg setup --write npm,docker                  # this machine's tools
    gm pkg download gm/latest/linux-x86_64/gm -O orbit --dest ./gm
    gm pkg install gm -O orbit                      # verified executable in ~/.local/bin
    gm pkg install gm -O orbit --force               # atomic update, including running gm

Downloads verify the registry's SHA-256 before atomically saving. Install selects
<os>-<arch>/<name> (for example linux-x86_64/gm); --file overrides that artifact
path, --version pins a release and --bin-dir chooses the installation directory.
Existing files require --force. No archives are unpacked or installer scripts run.

## Conflicts
Rebases never stop halfway. A conflicted change gets conflict markers in its
files and shows up in `gm status` under `conflicts`. Edit the markers away
in `@` (or `gm edit <change>` first); the next gm command records the fix.
`gm push` refuses changes that still have conflicts.

## For agents
- Output is compact JSON when an agent or a pipe is detected; `-o text` for prose.
- Errors are JSON on stderr: `{"error":{"code","message","hint"}}`. Exit codes:
  1 error, 2 bad usage, 3 not found, 4 needs a decision (conflict, behind
  trunk), 5 auth.
- `gm cli search "<task>"` finds commands; `gm schema <command>` gives exact
  inputs and the output JSON Schema. Every mutating command takes `--dry-run`.
- Sign in once: `gm auth login --ssh` (an SSH key from your agent, 1Password
  or ~/.ssh, registered with `gm auth ssh-key add`; in WSL it follows git's
  `core.sshCommand`, e.g. ssh.exe), `--token gmx_…`, or `--persona <name>` in dev.
"#;

#[derive(Serialize)]
pub struct Guide {
    pub guide: &'static str,
}

impl Render for Guide {
    fn text(&self) -> String {
        self.guide.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_has_metadata_and_every_metadata_has_a_command() {
        let commands: Vec<String> = manifest()
            .iter()
            .map(|e| e.command.trim_start_matches("gm ").to_string())
            .collect();
        for c in &commands {
            assert!(find(c).is_some(), "no metadata for `gm {c}`");
        }
        for m in COMMANDS {
            assert!(
                commands.iter().any(|c| c == m.path),
                "metadata for unknown command `gm {}`",
                m.path
            );
        }
    }

    #[test]
    fn search_finds_the_obvious_command() {
        let top = |q: &str| {
            search(q)
                .first()
                .map(|h| h.command.clone())
                .unwrap_or_default()
        };
        assert_eq!(top("undo the last thing I did"), "gm undo");
        assert_eq!(top("cherry-pick a commit"), "gm duplicate");
        assert_eq!(top("revert a change"), "gm backout");
        assert_eq!(top("save my work with a message"), "gm commit");
        assert_eq!(top("pull latest changes"), "gm sync");
        assert_eq!(top("create a branch"), "gm bookmark set");
        assert_eq!(top("discard my edits to a file"), "gm restore");
        assert_eq!(top("open a pull request"), "gm push");
    }
}
