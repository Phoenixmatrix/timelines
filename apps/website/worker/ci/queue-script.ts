// Trusted CI program, not repository code. Keep conflict checks independent of
// the service/model: approval can only select one of two lossless append orders.
// Only system-installed tools may execute with the merge credential. The scoped
// PATH works with the Sandbox image and Linux runners (including Node 18); it
// deliberately ignores repo .bin entries and user-managed runtime shims.
// Ordinary repository steps keep the runner's normal PATH.
export const QUEUE_RESOLVE_TIMEOUT_MS = 210_000; // 65s classification + 125s repair + persistence.

export function queueMergeScript(resolveTimeoutMs = QUEUE_RESOLVE_TIMEOUT_MS): string {
  if (!Number.isSafeInteger(resolveTimeoutMs) || resolveTimeoutMs <= 0)
    throw new Error("Invalid queue resolution deadline");
  return String.raw`(
export PATH=/usr/local/bin:/usr/bin:/bin
unset NODE_OPTIONS NODE_PATH GIT_EXEC_PATH
node --input-type=commonjs <<'GITMATRIX_QUEUE_SCRIPT'
const { execFileSync } = require('node:child_process');
const e = process.env;
const fail = (message, exitCode = 42) => { throw Object.assign(new Error(message), { exitCode }); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const oid = /^[0-9a-f]{40}$/;
const env = { ...e, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: 'Authorization: Bearer ' + e.GITMATRIX_TOKEN,
  GIT_AUTHOR_NAME: e.GITMATRIX_LANDING_NAME, GIT_AUTHOR_EMAIL: e.GITMATRIX_LANDING_EMAIL,
  GIT_COMMITTER_NAME: e.GITMATRIX_LANDING_NAME, GIT_COMMITTER_EMAIL: e.GITMATRIX_LANDING_EMAIL };
function git(args, input) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgSign=false', ...args], {
    env, input, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
function safePath(path) {
  return Buffer.byteLength(path, 'utf8') <= 160 && /^docs\/(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*\/)*[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*\.(?:md|txt)$/u.test(path)
    && !/(?:agent|claude|gemini|copilot|instruction|prompt|config|auth|security|permission|policy|migration|dependenc|lock|generated|vendor|build|dist|workflow|ci(?:[./_-]|$))/i.test(path);
}
function text(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 4096
    && /^[\p{L}\p{M}\p{N} \n.,!?'"():#*+\-。、「」！？“”‘’–—…¿¡]+$/u.test(value)
    && !/(?:<{7}|={7}|>{7}|\|{7})/.test(value)
    && !/\b(?:agent|assistant|instruction|prompt|system|ignore|override|execute|command|shell|script|sudo|curl|wget|config|migration|dependency|generated|credential|password|secret|token|auth|security|permission|policy)\b/i.test(value);
}
function additive(file) {
  if (!safePath(file.path) || ![file.base, file.ours, file.theirs].every(text)
      || ![file.base, file.ours, file.theirs].every(side => side.endsWith('\n'))
      || !file.ours.startsWith(file.base) || !file.theirs.startsWith(file.base)) return false;
  const ours = file.ours.slice(file.base.length), theirs = file.theirs.slice(file.base.length);
  return !!ours.trim() && !!theirs.trim() && ours.trim() !== theirs.trim()
    && !ours.includes(theirs.trim()) && !theirs.includes(ours.trim());
}
async function main() {
  const source = e.GITMATRIX_COMMIT, base = e.GITMATRIX_LANDING_BASE;
  if (!oid.test(source || '') || !oid.test(base || '') || !oid.test(e.GITMATRIX_QUEUE_ID || '')
      || !/^[1-9][0-9]*$/.test(e.GITMATRIX_QUEUE_ATTEMPT || '')
      || source === base || e.GITMATRIX_LANDING_BRANCH !== 'gitmatrix/landing/queue-' + e.GITMATRIX_QUEUE_ID + '-' + e.GITMATRIX_QUEUE_ATTEMPT)
    fail('Invalid pinned queue merge', 1);
  git(['check-ref-format', 'refs/heads/' + e.GITMATRIX_LANDING_MAIN]);
  const remote = e.GITMATRIX_URL + '/' + e.GITMATRIX_REPOSITORY + '.git';
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  git(['fetch', '--quiet', ...(shallow ? ['--unshallow'] : []), remote,
    '+refs/heads/' + e.GITMATRIX_LANDING_MAIN + ':refs/remotes/queue/main']);
  for (const commit of [base, source]) git(['cat-file', '-e', commit + '^{commit}']);
  git(['checkout', '--quiet', '--detach', base]);
  let conflict = false;
  try { git(['merge', '--no-ff', '--no-commit', '--no-edit', source]); }
  catch { conflict = true; }
  if (conflict) {
    const entries = git(['ls-files', '--unmerged', '-z']).split('\0').filter(Boolean);
    if (!entries.length) fail('Merge failed without conflict stages', 1);
    const paths = [...new Set(entries.map(entry => entry.slice(entry.indexOf('\t') + 1)))]
      .filter(path => path.length > 0 && Buffer.byteLength(path, 'utf8') <= 256
        && !/[\x00-\x1f\x7f]/.test(path) && !path.startsWith('/')
        && !path.split('/').some(part => part === '..' || part === '.')).slice(0, 100);
    console.error('QUEUE_CONFLICT_PATHS ' + JSON.stringify(paths));
    const stages = new Map();
    for (const entry of entries) {
      const match = /^(100644) ([0-9a-f]{40}) ([123])\t(.+)$/.exec(entry);
      if (!match || !safePath(match[4])) fail('Unsafe conflict path or mode');
      const path = match[4], stage = Number(match[3]);
      if (!stages.has(path)) stages.set(path, {});
      const versions = stages.get(path);
      if (versions[stage]) fail('Ambiguous conflict stage');
      const size = Number(git(['cat-file', '-s', match[2]]).trim());
      if (!Number.isSafeInteger(size) || size > 4096) fail('Oversized conflict');
      versions[stage] = git(['cat-file', 'blob', match[2]]);
    }
    if (!stages.size || stages.size > 3) fail('Conflict requires manual resolution');
    const files = [...stages].map(([path, v]) => ({ path, base: v[1], ours: v[2], theirs: v[3] }));
    if (files.some(file => !additive(file)) || files.reduce((n, f) =>
        n + Buffer.byteLength(f.base + f.ours + f.theirs, 'utf8'), 0) > 16384)
      fail('Conflict is not bounded additive documentation');
    const response = await fetch(e.GITMATRIX_URL + '/api/repos/' + e.GITMATRIX_REPOSITORY
      + '/queue/' + e.GITMATRIX_QUEUE_ID + '/resolve', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(${resolveTimeoutMs}),
      headers: { Authorization: 'Bearer ' + e.GITMATRIX_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }) });
    if (!response.ok || !response.body) fail('Conflict resolution endpoint failed', 1);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 32768) fail('Oversized conflict resolution');
      chunks.push(chunk);
    }
    const resolution = JSON.parse(Buffer.concat(chunks).toString('utf8')).resolution;
    if (!resolution) fail('Conflict resolution endpoint returned no result', 1);
    if (!keys(resolution, ['decision', 'files', 'repairModel'])
        || !keys(resolution.decision, ['action', 'reason', 'model', 'confidence'])
        || resolution.decision.action !== 'repair' || typeof resolution.decision.reason !== 'string'
        || resolution.decision.reason.length > 240
        || typeof resolution.decision.model !== 'string' || !resolution.decision.model.trim()
        || typeof resolution.decision.confidence !== 'number' || !Number.isFinite(resolution.decision.confidence)
        || resolution.decision.confidence < 0.95
        || resolution.decision.confidence > 1 || typeof resolution.repairModel !== 'string'
        || !resolution.repairModel.trim() || !Array.isArray(resolution.files)
        || resolution.files.length !== files.length) fail('Conflict repair not explicitly approved');
    const approved = new Map();
    for (const output of resolution.files) {
      const file = files.find(f => f.path === output?.path);
      if (!keys(output, ['path', 'content']) || !file || approved.has(file.path)
          || typeof output.content !== 'string') fail('Unexpected repair path');
      const ours = file.ours.slice(file.base.length), theirs = file.theirs.slice(file.base.length);
      if (output.content !== file.base + ours + theirs && output.content !== file.base + theirs + ours)
        fail('Repair does not preserve both additions');
      approved.set(file.path, output.content);
    }
    // Write only index blobs: no symlink following, filters or model commands.
    for (const [path, content] of approved) {
      const blob = git(['hash-object', '-w', '--stdin'], content).trim();
      git(['update-index', '--add', '--cacheinfo', '100644', blob, path]);
    }
    if (git(['ls-files', '--unmerged', '-z'])) fail('Unresolved conflict');
  }
  const tree = git(['write-tree']).trim();
  // commit-tree deliberately creates two parents even if source is an ancestor.
  const candidate = git(['commit-tree', tree, '-p', base, '-p', source], e.GITMATRIX_LANDING_MESSAGE + '\n').trim();
  if (git(['show', '-s', '--format=%P', candidate]).trim() !== base + ' ' + source)
    fail('Invalid queue candidate parents', 1);
  git(['push', '--quiet', '--force', remote, candidate + ':refs/heads/' + e.GITMATRIX_LANDING_BRANCH]);
  console.log('Merged as ' + candidate + '.');
}
main().catch(error => { console.error('Queue merge failed: unsafe conflict, denied repair, or infrastructure failure.'); process.exitCode = error.exitCode === 42 ? 42 : 1; });
GITMATRIX_QUEUE_SCRIPT
)
`;
}

export const QUEUE_MERGE_SCRIPT = queueMergeScript();
