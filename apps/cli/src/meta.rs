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
    meta!("settings ai show", git: "", kw: "account organization automatic ai settings policy costs pricing models catalog permissions knowledge wiki atlas release notes", mutates: false, out: Out::Other("AiSettingsView {features:{knowledge,wiki,atlas,releaseNotes},models:{classification,fast,task},updatedAt:string|null,updatedBy:string|null,canManage:boolean,catalog:{classification:ModelOption[],fast:ModelOption[],task:ModelOption[]}}; ModelOption {id,name,model,releasedAt,inputUsdPerMillion,outputUsdPerMillion,url}"), ex: ["gm settings ai show", "gm settings ai show --owner orbit"]),
    meta!("settings ai set", git: "", kw: "account organization automatic ai settings enable disable spending policy model classification fast task knowledge wiki atlas release notes", mutates: true, out: Out::Other("AiSettingsView as returned by settings ai show; --dry-run returns {dry_run:true,owner,method:'PATCH',path,request:{features?:{knowledge?,wiki?,atlas?,releaseNotes?},models?:{classification?,fast?,task?}}} without mutation. Requires at least one change. Backend requires a human account/org owner or site admin."), ex: ["gm settings ai set --owner orbit --knowledge off --dry-run", "gm settings ai set --owner orbit --classification clef --fast glm-5.3-flash --task gemma-4-26b-a4b-it"]),
    meta!("tracker list", git: "", kw: "accounts organizations issue trackers", mutates: false, out: Out::Other("{trackers:[{id,slug,displayName,canAdmin}]}"), ex: ["gm tracker list"]),
    meta!("tracker use", git: "", kw: "select owner initialize offline replica account organization", mutates: true, out: Out::Other("{owner,identity,replica,cursor}"), ex: ["gm tracker use orbit"]),
    meta!("tracker sync", git: "", kw: "offline replica outbox synchronize upload download cursor", mutates: true, out: Out::Other("{dryRun,cursor,pending}; conflicts stop ordered replay without dropping later edits"), ex: ["gm tracker sync"]),
    meta!("tracker status", git: "", kw: "replica pending queue identity cache path", mutates: false, out: Out::Other("{owner,identity,defaultTeam:{key,source,why,change},cursor,timelines:[{slug,name,status,parent,experimental,createdAt}],operations,replica,credentialPartitions,credentialRotation}"), ex: ["gm tracker status --offline"]),
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
    meta!("issue create", git: "", kw: "ticket task bug prd markdown acceptance offline stable id default team timeline required never policy", mutates: true, out: Out::Other("{operationId,queued,entities:[Issue],cursor,team?:{key,source,why,change}}; --team defaults to .gitmatrix scope, then your default team; offline key is null until synchronized; Issue.timelineUse is agent_decides (default), required or never, with timelinePolicy auto|approval|null"), ex: ["gm issue create 'Ship search' --team ENG --type prd --description-file spec.md", "gm issue create 'Migrate billing' --team ENG --timeline-use required --timeline-policy approval"]),
    meta!("issue list", git: "", kw: "tickets issues filter search status type remediation queue failure team workspace bounded default all teams", mutates: false, out: Out::Other("{team:{key,source,why,change},issues:[Issue],total,truncated,offline,readinessAdvisory,cursor,cachedAt,timeline,next}; Issue.queueFailure is read-only merge/gate/deployment evidence"), ex: ["gm issue list --workspace launch --limit 20", "gm issue list --type remediation"]),
    meta!("issue ready", git: "", kw: "ready frontier agent unblocked available work dependency blockers type remediation queue failure", mutates: false, out: Out::Other("{team:{key,source,why,change},issues:[Issue],total,truncated,offline,readinessAdvisory:true,cursor,cachedAt,timeline,next}; acquire an online claim before work"), ex: ["gm issue ready --limit 10", "gm issue ready --type remediation"]),
    meta!("issue show", git: "", kw: "bounded context creator attribution ancestors parent prd blockers dependents checkpoint evidence", mutates: false, out: Out::Other("{issue:{...,createdBy,creatorDisplay},ancestors,links,relatedIssues,notes,limitPerSection,truncated,ready,readinessAdvisory,cursor,cachedAt,offline,timeline}"), ex: ["gm issue show ENG-1 --limit 20"]),
    meta!("issue history", git: "", kw: "audit history creator attribution actor agent accountable source timestamp mutation before after pagination online", mutates: false, out: Out::Other("{issueId,creator:AuditActor|null,events:[{cursor,operationId,actorId,actor:{id,kind,name,accountable},source,kind,mutationKind,entityType,entityId,before,entity,createdAt}],nextBefore:number|null,hasMore}; newest first; --before is exclusive; online only"), ex: ["gm issue history ENG-1 --owner orbit --limit 50", "gm issue history ENG-1 --owner orbit --before 120 --json"]),
    meta!("issue update", git: "", kw: "edit issue version optimistic status assignment acceptance labels timeline required never policy", mutates: true, out: Out::Other("{operationId,queued,entities:[Issue],cursor}"), ex: ["gm issue update ENG-1 --data '{\"priority\":1}' --offline", "gm issue update ENG-1 --timeline-use required --timeline-policy auto"]),
    meta!("issue link", git: "", kw: "dependency blocker related duplicate directed graph", mutates: true, out: Out::Other("{operationId,queued,entities:[Link],cursor}"), ex: ["gm issue link ENG-1 ENG-2 --kind blocks"]),
    meta!("issue unlink", git: "", kw: "remove dependency blocker relation", mutates: true, out: Out::Other("{operationId,queued,entities:[],cursor}"), ex: ["gm issue unlink LINK_ID"]),
    meta!("issue comment", git: "", kw: "durable markdown comment discussion", mutates: true, out: Out::Other("{operationId,queued,entities:[Comment],cursor}"), ex: ["gm issue comment ENG-1 'Investigating the failing build'"]),
    meta!("issue checkpoint", git: "", kw: "agent durable checkpoint progress decisions handoff resume", mutates: true, out: Out::Other("{operationId,queued,entities:[Comment],cursor}"), ex: ["gm issue checkpoint ENG-1 '@checkpoint.md'"]),
    meta!("issue evidence", git: "", kw: "verification evidence proof durable test result", mutates: true, out: Out::Other("{operationId,queued,entities:[Comment],cursor}"), ex: ["gm issue evidence ENG-1 'Verified with integration smoke'"]),
    meta!("issue batch", git: "", kw: "atomic graph dependency mutations offline batch json", mutates: true, out: Out::Other("{operationId,queued,entities:[Entity],cursor}; input array of {kind,id,expectedVersion?,data?}, max 100, canonical IDs"), ex: ["gm issue batch '@plan.json' --offline"]),
    meta!("issue next", git: "", kw: "next ready work pick claim agent graph autonomous loop lease intervention harness", mutates: true, out: Out::Other("{claimed:{issueId,key,leaseToken,expiresAt}|null,intervention:{mode:'autonomous'|'harness',guidance},timelineRule:{use:'agent_decides'|'required'|'never',policy:'auto'|'approval'|null,guidance},context,blockerEvidence,team:{key,source,why,change}}; flags default from .gitmatrix (gm agent setup), then your default team; gm keeps the lease token privately for this identity"), ex: ["gm issue next", "gm issue next --under CORE-4", "gm issue next --agent builder --team CORE", "gm issue next --timeline search"]),
    meta!("issue ask", git: "", kw: "ask person human question approval decision credential blocked waiting intervention park lease", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["GM_LEASE_TOKEN=… gm issue ask ENG-3 --kind question --prompt \"Which region should this deploy to?\"", "gm issue ask ENG-3 --kind decision --prompt \"Which store?\" --choice D1 --choice R2", "gm issue ask ENG-3 --kind approval --checkpoint cp_… --prompt \"Land search-v2?\""]),
    meta!("issue resume", git: "", kw: "resume parked lease after answer continue intervention", mutates: true, out: Out::Other("{cursor,events,results:[{id,leaseToken,expiresAt}],intervention:{mode:'autonomous'|'harness',guidance}}; gm keeps the fencing token privately for this identity"), ex: ["gm issue resume ENG-3"]),
    meta!("request list", git: "", kw: "requests needs you waiting on person questions approvals answered canceled status issue resume", mutates: false, out: Out::Other("{requests:[{id,issueId,kind,prompt,choices,secret,checkpoint?:{id,number,timelineId,timeline},status,askedBy,routeTo,answer,answeredBy,answeredAt,issue,asker,for,checkpointView?:CheckpointView}],next}; --status open (default), answered, canceled or all; --issue filters by issue key or canonical ID"), ex: ["gm request list", "gm request list --status answered", "gm request list --issue ENG-3 --status all"]),
    meta!("request answer", git: "", kw: "answer request approve reject choose decision credential secret", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["gm request answer 3f2c --answer eu-west", "gm request answer 3f2c --approve", "gm request answer 3f2c   # a credential: prompts for the value"]),
    meta!("request cancel", git: "", kw: "withdraw cancel request", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["gm request cancel 3f2c"]),
    meta!("issue handoff", git: "", kw: "hand off give transfer lease agent offer code", mutates: true, out: Out::Other("{cursor,events,results:[{id,offerCode,expiresAt}]}; offerCode is single-use"), ex: ["GM_LEASE_TOKEN=… gm issue handoff ENG-3 --to reviewer"]),
    meta!("issue withdraw", git: "", kw: "withdraw cancel handoff offer", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["GM_LEASE_TOKEN=… gm issue withdraw ENG-3"]),
    meta!("issue accept", git: "", kw: "accept handoff take over lease transfer code intervention", mutates: true, out: Out::Other("{cursor,events,results:[{id,leaseToken,expiresAt}],intervention:{mode:'autonomous'|'harness',guidance}}; gm keeps the fencing token privately for this identity"), ex: ["gm issue accept ENG-3.4f…"]),
    meta!("issue revoke", git: "", kw: "revoke take back delegated claim sub lease subtree", mutates: true, out: Out::Other("{cursor,events,results:[{id}]}"), ex: ["GM_UNDER_TOKEN=… gm issue revoke ENG-12"]),
    meta!("issue claim", git: "", kw: "exclusive online claim fence agent lease token force take over override admin owner autonomous intervention harness", mutates: true, out: Out::Other("{cursor,events,results:[{id,leaseToken,expiresAt}],serverTime,timelineRule:{use,policy,guidance},intervention:{mode:'autonomous'|'harness',guidance}}; gm keeps leaseToken privately for this identity, so lease commands need no token"), ex: ["gm issue claim ENG-1", "gm issue claim ENG-1 --agent build-agent", "GM_UNDER_TOKEN=… gm issue claim ENG-12 --agent sub --for reviewer", "gm issue claim ENG-1 --force"]),
    meta!("issue renew", git: "", kw: "lease renew online fencing token expiration", mutates: true, out: Out::Other("{cursor,events,results,serverTime}; token may appear only in claim/renew responses"), ex: ["gm issue renew ENG-1 --ttl 900"]),
    meta!("issue release", git: "", kw: "force end someone else claim owner admin release exclusive fenced claim online", mutates: true, out: Out::Other("{cursor,events,results,serverTime}; lease token redacted"), ex: ["gm issue release ENG-1", "gm issue release ENG-1 --force"]),
    meta!("issue complete", git: "", kw: "finish issue online fencing evidence done", mutates: true, out: Out::Other("{cursor,events,results,serverTime}; lease token redacted"), ex: ["gm issue complete ENG-1 --evidence '@verification.md'"]),
    meta!("status", git: "git status", kw: "what changed working copy modified files uncommitted dirty state where am i", mutates: false, out: Out::Typed(schema_of::<model::Status>), ex: ["gm status"]),
    meta!("log", git: "git log --oneline --graph", kw: "history list changes commits recent graph unpushed", mutates: false, out: Out::Typed(schema_of::<model::Log>), ex: ["gm log", "gm log -r all -n 20", "gm log -r trunk..@"]),
    meta!("show", git: "git show", kw: "inspect view change commit details patch", mutates: false, out: Out::Typed(schema_of::<model::Diff>), ex: ["gm show", "gm show @- --stat"]),
    meta!("diff", git: "git diff", kw: "difference patch compare changes lines edits", mutates: false, out: Out::Typed(schema_of::<model::Diff>), ex: ["gm diff", "gm diff --stat", "gm diff --from trunk --to @", "gm diff src/"]),
    meta!("describe", git: "git commit --amend -m (message only)", kw: "message rename reword edit description amend commit message title", mutates: true, out: OP, ex: ["gm describe -m \"Fix login redirect\"", "gm describe @- -m \"Better message\""]),
    meta!("new", git: "git switch -c / git stash / git merge --no-commit", kw: "start begin fresh empty change branch off checkout switch merge stash", mutates: true, out: OP, ex: ["gm new", "gm new trunk -m \"Try another approach\"", "gm new kxyz lmno"]),
    meta!("merge", git: "git merge --no-ff", kw: "merge branch bookmark timeline main trunk into combine join integrate two parents merge commit", mutates: true, out: OP, ex: ["gm merge trunk", "gm merge feature-x -m \"Merge feature-x\"", "gm merge kxyz lmno"]),
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
    meta!("why", git: "git blame -L", kw: "why blame provenance history reason line annotate who changed explain change id timeline issue checkpoint approval landing merged rebase", mutates: false, out: Out::Other("WhyResponse {repo:{owner,name,defaultBranch},tracker:{owner,readable},blame:{source:'local',path,rev,head,start,end,lines:[{line,commit,originalLine}],truncated},chains:[{oid,onServer,commit:{oid,message,authorName,authorEmail,authoredAt,parents},lines:[number],changeId:string|null,changeSource:'client'|'push-log'|'header'|null,refs:[{ref,kind:'main'|'timeline'|'branch'|'tag',timeline:WhyTimeline|null,firstCommit,firstSeenAt,firstUpdate:{id,ref,old,new,forced,actor,agent,createdAt},lastCommit,lastSeenAt,rewritten,afterLanding}],timelines:[{id,slug,name,status,policy,experimental}],merges:[{from:string|null,into:string|null,commit,parent,at,actorId}],issues:[{id,key,title,status,trackerOwner,source:'commit'|'timeline'}],checkpoints:[{id,timeline,number,commit,summary,createdAt,actorId,current,approval:{requestId,state,by,at,note}|null}],approval:{requestId,state,by,at,note,checkpointId,timeline,number}|null,landing:{ref,commit,at,update,via:'queue'|'push'|'unknown',timeline:string|null,queue:{id,checkpointId,checkpointNumber,trigger:'auto'|'approval'|'request',requestedBy:{actorId,accountableId,agentId},mergeRun:{id,number}|null,gateRun:{id,number}|null}|null}|null,discussions:{available:false,reason,threads:[]}}],people:{[id]:{name,kind:'person'|'agent'}}}; one chain per commit blame names, in line order. Blame runs locally; the chain after the commit follows the change id, so it survives rebases. Queue provenance identifies the exact advanced repository and checkpoint; a plain push observation does not prove queue landing. Without tracker access, tracker records are empty and tracker.readable is false."), ex: ["gm why src/app.ts:42", "gm why src/app.ts -L 40-48 --rev trunk", "gm why apps/cli/src/main.rs:10 -o text"]),
    meta!("file list", git: "git ls-tree -r --name-only", kw: "ls files tree list paths", mutates: false, out: Out::Typed(schema_of::<crate::commands::local::FileList>), ex: ["gm file list", "gm file list src -r trunk"]),
    meta!("worktree add", git: "git worktree add --detach", kw: "parallel agent isolated checkout workspace create worktree include env ignored setup", mutates: true, out: Out::Typed(schema_of::<crate::commands::worktree::WorktreeResult>), ex: ["gm worktree add ../feature", "gm worktree add ../feature -r trunk --include"]),
    meta!("worktree list", git: "git worktree list", kw: "worktrees workspaces checkouts list parallel", mutates: false, out: Out::Typed(schema_of::<crate::commands::worktree::WorktreeResult>), ex: ["gm worktree list"]),
    meta!("worktree remove", git: "git worktree remove", kw: "worktree workspace checkout delete remove cleanup", mutates: true, out: Out::Typed(schema_of::<crate::commands::worktree::WorktreeResult>), ex: ["gm worktree remove ../feature", "gm worktree remove ../feature --force"]),
    meta!("init", git: "git init (then adopt)", kw: "initialize start adopt existing repository setup", mutates: true, out: OP, ex: ["gm init"]),
    meta!("clone", git: "git clone", kw: "download copy checkout repository get code progress transfer quiet", mutates: true, out: Out::Typed(schema_of::<crate::commands::network::Cloned>), ex: ["gm clone orbit/engine", "gm clone orbit/engine ./engine", "gm clone orbit/engine --quiet"]),
    meta!("fetch", git: "git fetch", kw: "download remote update refresh get latest", mutates: true, out: Out::Other("{trunk:{before,after}|null,updated_refs:[name]}"), ex: ["gm fetch"]),
    meta!("sync", git: "git pull --rebase", kw: "pull update rebase onto latest trunk catch up refresh", mutates: true, out: OP, ex: ["gm sync"]),
    meta!("context sync", git: "", kw: "step context upload retry offline why instructions steering agent work history timeline", mutates: true, out: Out::Typed(schema_of::<crate::commands::steps::Synced>), ex: ["gm context sync"]),
    meta!("push", git: "git push", kw: "upload publish land ship merge deploy send pull request pr queue asynchronous issue", mutates: true, out: Out::Typed(schema_of::<crate::commands::network::Pushed>), ex: ["gm push --queue --issue ENG-1", "gm push", "gm push --sync", "gm push -b feature-x"]),
    meta!("queue list", git: "", kw: "merge queue admissions status failure deployment pending", mutates: false, out: Out::Other("{entries:[QueueEntry]}"), ex: ["gm queue list", "gm queue list --status failed -R owner/repo"]),
    meta!("queue show", git: "", kw: "merge queue admission status evidence remediation conflict deployment", mutates: false, out: Out::Other("{entry:QueueEntry}; QueueEntry includes id,commit,status,coveredBy,mergeRun,gateRun,deployRun,deployStatus,failure,remediationIssueId"), ex: ["gm queue show COMMIT_ID"]),
    meta!("queue wait", git: "", kw: "merge queue monitor wait landing main pipeline deployment covered verdict", mutates: false, out: Out::Other("{entry:QueueEntry}; follows coveredBy; exit 0 only on landing (and succeeded main pipeline with --deploy), nonzero on failure/cancel/timeout"), ex: ["gm queue wait COMMIT_ID --deploy --timeout 1800"]),
    meta!("queue cancel", git: "", kw: "merge queue cancel pending admission no rewind", mutates: true, out: Out::Other("{entry:QueueEntry}; --dry-run: {dry_run,id,action}"), ex: ["gm queue cancel COMMIT_ID"]),
    meta!("queue retry", git: "", kw: "merge queue retry failed cancelled admission same commit", mutates: true, out: Out::Other("{entry:QueueEntry}; --dry-run: {dry_run,id,action}"), ex: ["gm queue retry COMMIT_ID"]),
    meta!("timeline start", git: "git switch -c (shared, server-side)", kw: "timeline start create fork parallel line work branch experiment approval policy agent separate", mutates: true, out: Out::Other("{dry_run,owner,timeline:Timeline,bookmarks:[{repoId,ref,ok,reason?}],use:<timeline use result>}; --dry-run: {dry_run,owner,request,use}"), ex: ["gm timeline start search-v2", "gm timeline start search-v2 --policy approval --name \"Search v2\"", "gm timeline start probe --experimental --from search-v2", "gm timeline start shared --repo orbit/engine --repo orbit/web"]),
    meta!("timeline list", git: "git branch -r --list 'origin/timeline/*'", kw: "timelines list parallel lines status landed abandoned stalled idle quiet", mutates: false, out: Out::Other("{timelines:[Timeline],owner,current,idleDays?}"), ex: ["gm timeline list", "gm timeline list --status active", "gm timeline list --stalled"]),
    meta!("timeline show", git: "", kw: "timeline show events history fork merge landing which timeline am i in", mutates: false, out: Out::Other("{timeline:Timeline,events:[TimelineEvent],next,current}"), ex: ["gm timeline show", "gm timeline show search-v2 --after 40"]),
    meta!("timeline use", git: "git switch <branch> (and push there by default)", kw: "timeline use switch bind checkout work in timeline go back main unbind", mutates: true, out: Out::Other("OpResult & {timeline,previous,bookmark,file,record}"), ex: ["gm timeline use search-v2", "gm timeline use main"]),
    meta!("timeline merge", git: "git merge --no-ff origin/<main|timeline>", kw: "timeline merge main into timeline sync catch up bring in other timeline combine", mutates: true, out: Out::Other("OpResult & {timeline,from,merged}"), ex: ["gm timeline merge main", "gm timeline merge search-v2"]),
    meta!("timeline checkpoint", git: "", kw: "timeline checkpoint snapshot record commits approval gate review summary preview ci ready for review", mutates: true, out: Out::Other("CheckpointView {checkpoint:{id,number,repos:[{id,owner,name,commit,base,changes}],summary,actorId,createdAt},current,approval,approved,timeline,runs,previews} & {dry_run,next}"), ex: ["gm timeline checkpoint -m 'Search v2 ranking is ready: …'", "gm timeline checkpoint search-v2 -m @summary.md"]),
    meta!("timeline checkpoints", git: "", kw: "timeline checkpoints list approvals approved superseded ci previews", mutates: false, out: Out::Other("{checkpoints:[CheckpointView],owner,timeline}"), ex: ["gm timeline checkpoints", "gm timeline checkpoints search-v2"]),
    meta!("timeline revive", git: "", kw: "timeline preview revive rebuild regenerate restore expired torn down checkpoint deploy again investigate old", mutates: true, out: Out::Other("{checkpoint:CheckpointView,runs:[{repoId,number,runId}|{repoId,skipped}],owner,dry_run}; each started run is a preview `create` (trigger preview) at the checkpoint's commit; the deployment it records is marked revived (rebuilt, not the original)"), ex: ["gm timeline revive", "gm timeline revive search-v2 --checkpoint 3", "gm timeline revive search-v2 -c cp_…"]),
    meta!("timeline pages", git: "", kw: "timeline wiki pages knowledge docs review checkpoint gate components concepts glossary what changes write on demand", mutates: true, out: Out::Other("{owner,timeline,repos:[{repo,ended?,sets:[{ref,timeline,key,checkpoint:{id,number}|null,commit,baseCommit,state:'queued'|'writing'|'succeeded'|'failed'|'ended',counts,pages:[{slug,title,section,kind,change:'added'|'changed',outcome:'written'|'kept',excerpt,model}],skipped,error}]}],next}; --checkpoint: {owner,timeline,checkpoint,repos}; --page: the page in full {slug,title,body,generatedIn,outcome,set,repo}; --write queues them at the bookmarks' tips (AI; idempotent per commit; refused once the timeline ended)"), ex: ["gm timeline pages", "gm timeline pages search-v2 --checkpoint 2", "gm timeline pages --page components/apps-website-worker-knowledge", "gm timeline pages --write"]),
    meta!("timeline update", git: "git branch -m (the name only)", kw: "timeline update rename flag experimental unflag not expected to land marker", mutates: true, out: Out::Other("{dry_run,owner,timeline:Timeline}; --dry-run: {dry_run,owner,timeline,request}"), ex: ["gm timeline flag probe --experimental", "gm timeline update probe --no-experimental", "gm timeline update --name \"Search v2\""]),
    meta!("timeline land", git: "git merge --no-ff + CI + git push origin main (server-side, compare-and-swap)", kw: "timeline land landing queue merge into main ship release gates approve green partly landed conflict sync why can't land", mutates: true, out: Out::Other("{owner,queued,landing:Landing {id,slug,checkpointId,checkpointNumber,state:'merging'|'testing'|'advancing'|'conflict'|'failed'|'landed',repos:[{id,owner,name,commit,base,merge,attempt,state,mergeRun,gateRun,reason}],reason,trigger:'auto'|'approval'|'request',requestedBy}}; refused with needs_approval, not_green, checkpoint_stale or no_checkpoint saying why; --dry-run: {dry_run,owner,timeline}"), ex: ["gm timeline land", "gm timeline land search-v2"]),
    meta!("timeline abandon", git: "git push --delete origin timeline/<slug>", kw: "timeline abandon end prune discard drop delete timeline", mutates: true, out: Out::Other("{dry_run,owner,timeline:Timeline,bookmarks,use?}; --dry-run: {dry_run,owner,timeline,unbind}"), ex: ["gm timeline abandon", "gm timeline abandon probe --dry-run"]),
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
    meta!("deploy record", git: "", kw: "deploy deployment record preview environment url production timeline checkpoint ci job report where deployed", mutates: true, out: Out::Other("Deployment {id,environment,timeline,timelineId,checkpoint,commit,url,status:'active'|'sleeping'|'expired'|'failed',run,job,actor,agent,expiresAt,expiryPinned,revived,rebuiltFrom,tornDownAt,teardownRun,createdAt,updatedAt}. In a CI job (GITMATRIX_TOKEN) the server fills in the run, job, commit and environment from the branch (production, timeline/<slug> or branch/<name>); a preview run also fills in its checkpoint, and a revival marks the record revived. Elsewhere pass --commit. Timeline previews follow the org's retention unless --expires pins one. Records outlive expired previews."), ex: ["gm deploy record --url \"$PREVIEW_URL\"", "gm deploy record --url https://app.example.com --environment production --commit @-", "gm deploy record --status failed --timeline fast-search"]),
    meta!("deploy list", git: "", kw: "deployments environments previews where is it deployed url status history timeline commit run", mutates: false, out: Out::Other("{deployments:[Deployment],next:number|null}; newest first"), ex: ["gm deploy list", "gm deploy list --timeline fast-search", "gm deploy list --run 12", "gm deploy list --environment production --status active"]),
    meta!("deploy update", git: "", kw: "deployment status expire teardown sleeping failed url change mark preview expired", mutates: true, out: Out::Other("Deployment"), ex: ["gm deploy update 42 --status expired", "gm deploy update 42 --expires 2d"]),
    meta!("runs rerun", git: "", kw: "ci retry rerun again restart build flaky", mutates: true, out: Out::Other("{number}"), ex: ["gm runs rerun 12"]),
    meta!("runner", git: "", kw: "ci runner agent worker execute jobs locally self-hosted run pipelines dev", mutates: false, out: Out::Other("{jobs:[{repo,run,job,status}]} (one JSON line per job while running)"), ex: ["gm runner", "gm runner --once", "gm runner -R orbit/engine -v"]),
    meta!("secret list", git: "", kw: "ci secrets environment variables credentials list", mutates: false, out: Out::Other("{secrets:[{name,updatedAt}]}"), ex: ["gm secret list"]),
    meta!("secret set", git: "", kw: "ci add secret token credential environment variable", mutates: true, out: Out::Other("{set}"), ex: ["gm secret set NPM_TOKEN --value xyz", "echo $TOKEN | gm secret set CLOUDFLARE_API_TOKEN"]),
    meta!("ask", git: "", kw: "ask question assistant ai explain why how deepwiki chat codebase knowledge issues ci packages agent query", mutates: false, out: Out::Other("{chatId,url,repo,answer,tools:[label],next}; text output streams the answer; --write lets it change things"), ex: ["gm ask \"Why did run 44 fail?\"", "gm ask -R matrixorg/gitmatrix \"Where is the tracker's readiness computed?\"", "gm ask --chat CHAT_ID \"And who changed it last?\"", "gm ask --write \"File a bug for the flaky clone test in CORE\""]),
    meta!("assistant list", git: "", kw: "assistant conversations chats history", mutates: false, out: Out::Other("{chats:[{id,title,source,createdAt,updatedAt}]}"), ex: ["gm assistant list"]),
    meta!("assistant show", git: "", kw: "assistant conversation transcript messages", mutates: false, out: Out::Other("{id,title,source,messages:[{role,text,tools}]}"), ex: ["gm assistant show CHAT_ID"]),
    meta!("assistant delete", git: "", kw: "assistant delete conversation", mutates: true, out: Out::Other("{deleted}"), ex: ["gm assistant delete CHAT_ID"]),
    meta!("agent setup", git: "", kw: "configure set up agent harness claude codex cursor AGENTS.md skills instructions identity token profile scope gm issue next defaults .gitmatrix autonomous intervention unattended prompting software factory", mutates: true, out: Out::Other("{dryRun,agent,harness,model,tags,scope,intervention:'autonomous'|'harness',identity:{id,name,accountable,created,token,profile}|null,files:[{path,status}],next}; --check: {upToDate,intervention,files} or error code stale (exit 4)"), ex: ["gm agent setup", "gm agent setup --intervention autonomous", "gm agent setup --intervention harness", "gm agent setup --harness codex --model gpt-5 --tag rust", "gm agent setup --under CORE-4", "gm agent setup --check"]),
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
- There are no pull requests. `gm push` lands your changes on trunk (in a
  timeline, on the timeline's bookmark; see Timelines).

## The loop (commit early, commit often)
    gm status                      # where am I, what changed
    # ...edit files...
    gm commit -m "Add retry to fetch"   # describe @, start a fresh @ on top
    # ...edit more...
    gm commit -m "Cover retry in tests"
    gm push --queue --issue ENG-1   # asynchronous admission; not landing proof

`gm commit` is cheap: make one per logical step. To fix an earlier step,
edit files and run `gm squash --into <change id>`, or `gm edit <change id>`
then `gm new` to come back on top.

## Asynchronous main merge queue
For independent main work, `gm push --queue --issue ENG-1` uploads a deterministic
source ref and returns `queue.id`. The server merges onto current main, runs gates,
then advances main only with a passing candidate. Admission does not mark local
work immutable or prove deployment. Checkpoint the ID on the original issue.
    gm queue show COMMIT_ID
    gm queue wait COMMIT_ID --deploy --timeout 1800
    gm queue list --status failed
Monitor at work boundaries, not with busy polling. Keep/renew the original lease
or complete it only with honest evidence and a durable monitoring handoff. Start
new independent work from current trunk in another worktree; use `gm sync` later
to reconcile landed history. A lost response is not success: inspect the exact
commit ID before resubmitting. Queue failure never falls back to a direct push.
P0 `remediation` issues carry read-only `queueFailure` evidence. Use
`gm issue ready --type remediation`, then normal online claim/lease commands;
inspect conflict paths and run logs, submit a tested fix, and resolve only with
actual evidence. `gm queue retry ID` retries the same failed/cancelled source;
a changed fix commit needs a new `gm push --queue`.
Ordinary `gm push` and native Git pushes remain the explicit direct recovery path
for queue/configuration repairs. Timeline work still uses `gm push`, checkpoints,
and approved timeline landing; `--queue` is refused in a bound timeline.

## Revisions
`@` working copy · `@-` its (first) parent · `@--` grandparent · `trunk` · a change id
prefix (`kxmq`) · a commit id prefix (`1a2b3c`) · a bookmark name.
Ranges for `gm log -r`: `trunk..@`, `all`.

## Everyday commands (git equivalent)
- `gm status` (git status) · `gm diff` (git diff) · `gm log` (git log)
- `gm commit -m` (git commit -am) · `gm describe -m` (amend the message)
- `gm new` (start a fresh change; also how you "stash") · `gm edit <rev>`
- `gm squash` (amend/fixup) · `gm split -m msg <paths>` (partial commit)
- `gm restore [paths]` (discard edits) · `gm abandon <rev>` (drop a change)
- `gm rebase -d trunk` · `gm backout -r <rev>` (revert) · `gm duplicate <rev>` (cherry-pick)
- `gm merge <rev>` (git merge --no-ff: a merge change below @, e.g. `gm merge trunk`)
- `gm sync` (pull --rebase) · `gm push` (land on trunk) · `gm push -b name` (push a bookmark)
- `gm timeline start|use|merge|abandon` (work on a separate line that lands later)
- `gm why <path:line>` (git blame, then the change's timelines, issue, checkpoints, approval, landing)
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

## Timelines
A timeline is a separate line of work on `timeline/<slug>` that lands on main
later, automatically or after a person approves. Use one when the issue (its
timeline field, description or PRD) or a person asks; otherwise work on main.
    gm timeline start search-v2 --policy approval  # fork from main; work in it here
    gm push                       # goes to timeline/search-v2, never main
    gm timeline merge main        # only when a person asks; then gm push
    gm timeline use main          # back to main (`use <slug>` to join one)
    gm timeline checkpoint -m 'What it holds and why'  # pins the pushed commits
    gm issue ask CORE-5 --kind approval --checkpoint cp_… --prompt 'Land it?'
    gm timeline land              # queue the head checkpoint, or say why it can't land yet
    gm timeline list · gm timeline show · gm timeline checkpoints · gm timeline abandon
    gm timeline revive search-v2 -c 3   # rebuild an expired checkpoint's preview
    gm timeline flag <slug> --experimental   # not expected to land; --no-experimental clears it
`use` writes `timeline: <slug>` to .gitmatrix/agent.local.yml (worktrees copy
it). While bound, the timeline's bookmark is this checkout's trunk: push, sync
and immutability follow it, main stays reachable as `origin/main`, and pushing
to main is refused. `gm issue` commands work in its view of the tracker.
`GM_TIMELINE=<slug>` overrides the binding for one command.
Only a timeline's accountable person or the agent that started it may abandon it.
A checkpoint records each repository's pushed commit and main's, its changes and
your summary; it never changes. An approval pins one checkpoint, is given by a
person with write access (never an agent), and only counts while it is still the
timeline's head: new commits withdraw an open request, and need a new
checkpoint and a new approval.
Landing merges the checkpoint into each repository's current main in a CI job,
runs the repository's gates on the merge, and only then advances main to it:
`auto` timelines queue when the checkpoint's CI is green, `approval` ones when
a person approves it. A conflict stops landing and asks for a sync (merge main
in, push, checkpoint again); a main that moved is merged and tested again.

## Distributed tracker (no Git repository required)
    gm tracker use orbit
    gm team create ENG --name Engineering
    gm issue create 'Fix search' --team ENG --label frontend --label backend
    gm issue ready --limit 10
    gm issue show ENG-1 --limit 20
    gm issue history ENG-1 --owner orbit --limit 50
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
`--timeline <slug>` (default: GM_TIMELINE, then the checkout's timeline) works in a timeline's view: main's issues with
the timeline's changes on top. Reads show that view (cached for `--offline`), `next`
picks from it, and changes and new issues stay in the timeline until it lands.
`gm issue show` displays the immutable creator; unavailable legacy/offline attribution
stays unknown. `gm issue history` reads online audit pages, newest first, including
actor/agent, accountable person, source, time, operation and full before/after states.
Repeat with `--before NEXT_BEFORE` until `hasMore` is false; `--limit` is 1..100
(default 50). `--json` preserves the complete response. The source is a provenance
hint, not authentication; gm's transport declares `cli`.

## Tagging issues on creation
Label the expertise needed by the issue's actual scope and acceptance criteria,
not the intended agent. Use a small relevant set; reuse the team's spelling.
Without a team convention, use these lowercase work-area defaults:
- `ux`: user research, interaction design and usability.
- `frontend`: browser UI, styling and client-side behavior.
- `backend`: server logic, services and background jobs.
- `data`: schemas, migrations, queries and data pipelines.
- `architecture`: system boundaries, cross-cutting design and major tradeoffs.
- `api`: public interfaces, contracts and integrations.
- `security`: authentication, authorization and threat mitigation.
- `testing`: test strategy, test infrastructure and regression coverage.
- `infrastructure`: deployment, CI/CD, networking and runtime operations.
- `documentation`: user or developer documentation.
These are suggested free-form issue `labels`, not a registered or enforced
catalog. Reuse project-specific labels when needed; avoid synonyms, case variants
and speculative areas. Do not add `architecture` to every code change or `testing`
merely because all work needs verification. Label each child by its own scope.
Repeat `--label` (not `--tag`) for each area:
    gm issue create 'Fix keyboard navigation in search' --team ENG --type bug --label ux --label frontend
    gm issue show ENG-1 --json
Use the actual team and returned issue key; check the returned `labels`.
`gm issue update ENG-1 --data '{"labels":["ux","frontend"]}'` replaces the whole
list: preserve any unrelated labels still needed.
Issue labels describe work; agent profile tags and skills describe self-reported
capabilities. Profiles are advisory delegation hints, not proof of expertise or
claim restrictions. Compare them with the work and available evidence; do not
infer or publish capabilities just because an agent created or claimed an issue.

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
`gm agent setup --intervention autonomous` minimizes interactive interruptions:
record actionable questions/decisions/blockers with `gm issue ask`, then continue
independent work only within the user's requested scope while the lease is parked.
Use `--kind decision --choice A --choice B` for options. A dependency link alone
does not ask a person; open a request when the blocker requires human action.
Check `gm request list --status answered` at work boundaries; inspect
`gm request list --issue CORE-5 --status all` before resuming because other asks
may remain open. Stop cleanly when no authorized work is ready; do not busy-poll.
`--intervention harness` leaves intervention behavior to the harness or factory.
New setup defaults to autonomous; existing configuration without the setting keeps
harness behavior. The checkout's `intervention` overrides the repository's.
Claim, next, resume and accept return the effective `intervention: {mode,guidance}`.

Timeline or main? Each issue says whether its work goes in a timeline (work kept
apart from main until it lands): `timelineUse` is `agent_decides` (the default),
`required` or `never`, and `required` may name the `timelinePolicy` (`auto` lands
when green, `approval` after a person approves). `next` and `claim` lead with it
(`timelineRule`, with guidance). Follow `required` and `never`. When it's yours to
decide, read the description or PRD and comments first ("do this in an approval
timeline"); otherwise prefer a timeline for risky, broad or experimental work that
needs review before main, and main for small, safe changes. Record the choice in
a checkpoint before you start, so the issue links to its timeline or says why it
worked on main: `gm issue checkpoint CORE-5 'Timeline: <slug> (approval)'`, or
`'Timeline: main, because <why>'`. Set the rule with
`gm issue create|update --timeline-use required --timeline-policy approval`.

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
Gitmatrix deploys nothing; a job that deploys records where it went with
`gm deploy record --url "$URL"` (environment, commit and run come from the job;
a `timeline/<slug>` branch makes it that timeline's preview, another branch
deploys to `branch/<name>`; `--environment` overrides). Outside CI pass
`--commit`. `gm deploy list --run N|--timeline SLUG`, `gm deploy update ID --status expired`.
Previews: a repository opts in with `on: preview` in ci.yml; Gitmatrix starts a
preview run per checkpoint (`if: trigger == "preview" && action == "create"`),
a `teardown` run when it expires, and a `create` again on `gm timeline revive`.

## Account AI settings
    gm settings ai show --owner orbit
    gm settings ai set --owner orbit --knowledge off --dry-run
    gm settings ai set --owner orbit --classification clef --task gemma-4-26b-a4b-it

These settings cover every repository owned by an account. Without --owner,
gm uses your signed-in personal account, never the current repository owner.
Show includes management permission and the curated catalog's pricing and dates.
Set requires at least one option and human account/org owner or site-admin
authorization; explicit agent credentials cannot change spending policy.
Feature options --knowledge, --wiki, --atlas and --release-notes accept on|off.
Knowledge off prevents new wiki and Atlas AI work too; Atlas off preserves its
deterministic projection. Classification accepts only clef; fast and task accept
glm-5.3-flash|gemma-4-26b-a4b-it. Changes affect future jobs, not running work,
existing history or cached output, and saving does not trigger a rebuild.
--dry-run prints the nested PATCH request without changing account policy.

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
A conflict in a change below `@` (a `gm merge`, or a rebased stack): fix the
files in `@`, then `gm squash --into <change>` (plain `gm squash` for `@-`).
`gm push` refuses changes that still have conflicts.

## Merges
`gm merge <rev>` makes a merge change with parents `@-` and `<rev>`, below
`@`; push it like any change. Rewrites (describe, rebase, sync, abandon) keep
every parent. A merge's diff is what it adds on top of its parents merged.

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
        assert_eq!(top("merge a branch into mine"), "gm merge");
        assert_eq!(top("start a timeline"), "gm timeline start");
        assert_eq!(top("merge main into my timeline"), "gm timeline merge");
        assert_eq!(top("switch to timeline"), "gm timeline use");
    }
}
