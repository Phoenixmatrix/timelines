// Literal source avoids bundler helper injection into serialized functions.
// The runtime and its state live outside the synchronized source tree.
export const runtimeSource = String.raw`(async function runtime() {
  const fs = await import("node:fs");
  const http = await import("node:http");
  const net = await import("node:net");
  const crypto = await import("node:crypto");
  const { spawn } = await import("node:child_process");
  const { pipeline } = await import("node:stream/promises");
  const ROOT = "/workspace/repo";
  const STATE = "/workspace/.remote";
  const MAX_FILE = 64 * 1024 * 1024;
  const json = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
  const save = (path, value) => {
    const temporary = path + ".tmp-" + crypto.randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, path);
  };
  const exists = (path) => fs.existsSync(path);
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  const safe = (path, source = true) => {
    if (typeof path !== "string" || !path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path)) fail("Invalid relative path");
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) fail("Invalid relative path");
    if (source && parts.some((part) => /^(?:\.git|\.git-credentials|\.gitconfig|\.gitmatrix-agent|\.cloudflare|\.wrangler|node_modules|target|dist|\.remote|\.ssh|\.aws|\.config|\.npmrc|\.netrc|agent\.local\.yml|credentials(?:\..*)?|secrets(?:\.json)?|auth\.json|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(part) || /^(?:\.env|\.dev\.vars)/i.test(part) || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(part))) fail("Reserved source path");
    return parts;
  };
  // Anchor every operation in opened directory descriptors. A concurrently renamed
  // parent cannot redirect a write outside the root; no component follows links.
  const anchored = (relative, create = false, source = true) => {
    const parts = safe(relative, source);
    const descriptors = [fs.openSync(ROOT, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)];
    try {
      for (const part of parts.slice(0, -1)) {
        const path = "/proc/self/fd/" + descriptors.at(-1) + "/" + part;
        if (create) { try { fs.mkdirSync(path, { mode: 0o755 }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
        descriptors.push(fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
      }
      return { path: "/proc/self/fd/" + descriptors.at(-1) + "/" + parts.at(-1), close: () => descriptors.reverse().forEach((fd) => fs.closeSync(fd)) };
    } catch (e) { descriptors.reverse().forEach((fd) => fs.closeSync(fd)); throw e; }
  };
  const recordPath = (id) => STATE + "/processes/" + id + ".json";
  const validId = (id) => { if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) fail("Invalid process id"); return id; };
  const BASE = {
    HOME: "/root", PATH: ROOT + "/node_modules/.bin:" + ROOT + "/apps/website/node_modules/.bin:/usr/local/pnpm/bin:/usr/local/pnpm:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    PNPM_HOME: "/usr/local/pnpm", RUSTUP_HOME: "/usr/local/rustup", CARGO_HOME: "/usr/local/cargo",
    GITMATRIX_REMOTE_HOSTED: "1", GITMATRIX_AGENT_EXECUTION: "local", GITMATRIX_REMOTE_CREDENTIALS_FILE: STATE + "/credentials.json",
    GITMATRIX_REMOTE_OWNERSHIP_URL: "http://127.0.0.1:8787/ownership",
  };
  const allowedEnv = new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CI", "NODE_ENV", "GITMATRIX_REMOTE_ORIGIN", "GITMATRIX_AGENT_ID", "GITMATRIX_AGENT_PORT", "GITMATRIX_DEV_AI", "GITMATRIX_DEV_EMAIL", "GITMATRIX_DEV_PASSWORD", "GITMATRIX_AI", "GITMATRIX_PUBLIC_URL", "GITMATRIX_CI_IMAGE", "GITMATRIX_CONTAINER_IMAGES", "RUST_LOG", "CARGO_BUILD_JOBS"]);
  allowedEnv.add("GITMATRIX_REMOTE_HOSTED");
  allowedEnv.add("GITMATRIX_AGENT_EXECUTION");
  const checkedEnv = (env = {}) => {
    if (!env || typeof env !== "object" || Array.isArray(env)) fail("Invalid environment");
    for (const [key, value] of Object.entries(env)) if (!allowedEnv.has(key) || typeof value !== "string" || value.length > 32768 || value.includes("\0")) fail("Environment key is not allowed: " + key);
    if (env.GITMATRIX_REMOTE_HOSTED !== undefined && env.GITMATRIX_REMOTE_HOSTED !== "1" || env.GITMATRIX_AGENT_EXECUTION !== undefined && env.GITMATRIX_AGENT_EXECUTION !== "local") fail("Hosted execution mode is fixed");
    return env;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const processInfo = (pid) => {
    try {
      const text = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      return { pid: Number(pid), state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
    } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
  };
  const ownedProcesses = (record) => {
    const all = fs.readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).map(processInfo).filter(Boolean);
    const owned = new Map((record.owned ?? []).map((p) => [p.pid, p.start]));
    const parents = new Set(all.some((p) => p.pid === record.runnerPid && p.start === record.runnerStart) ? [record.runnerPid] : []);
    for (const p of all) if (owned.get(p.pid) === p.start) parents.add(p.pid);
    // The direct group remains owned when its leader exits before its children.
    const groups = new Set(all.filter((p) => owned.get(p.pid) === p.start).map((p) => p.group));
    if (record.pid && !all.some((p) => p.pid === record.pid && p.start !== record.pidStart)) groups.add(record.pid);
    let changed;
    do {
      changed = false;
      for (const p of all) if (p.pid !== record.runnerPid && !parents.has(p.pid) && (parents.has(p.parent) || groups.has(p.group))) {
        parents.add(p.pid); groups.add(p.group); changed = true;
      }
    } while (changed);
    return all.filter((p) => p.pid !== record.runnerPid && parents.has(p.pid) && p.state !== "Z");
  };
  const signalOwned = (owned, signal) => {
    for (const p of owned) {
      if (processInfo(p.pid)?.start !== p.start) continue;
      try { process.kill(p.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  if (process.argv[2] === "runner") {
    let stop;
    let cancellationRequested = false;
    const cancel = () => { cancellationRequested = true; stop?.("cancelled"); };
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const spec = JSON.parse(input);
    const file = recordPath(spec.id);
    const log = fs.openSync(STATE + "/processes/" + spec.id + ".log", "a", 0o600);
    const record = { id: spec.id, kind: spec.kind, status: "running", startedAt: Date.now(), runnerPid: process.pid };
    record.runnerStart = processInfo(process.pid)?.start;
    save(file, record);
    let child;
    let reason;
    let finishing = false;
    let deadline;
    const capture = () => { record.owned = ownedProcesses(record); save(file, record); };
    stop = (cause) => {
      if (reason || finishing) return;
      reason = cause;
      deadline = Date.now() + 30_000;
      capture();
      if (child?.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    };
    // The early handlers also cover cancellation while the command stdin arrives.
    const timer = setTimeout(() => stop("timeout"), spec.timeoutMs);
    const monitor = setInterval(() => {
      capture();
      if (deadline && Date.now() >= deadline) signalOwned(record.owned, "SIGKILL");
    }, 100);
    const finish = async (code) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      capture();
      signalOwned(record.owned, "SIGTERM");
      const cleanupDeadline = deadline ?? Date.now() + 30_000;
      while (record.owned.length) {
        if (Date.now() >= cleanupDeadline) signalOwned(record.owned, "SIGKILL");
        await sleep(25);
        capture();
      }
      clearInterval(monitor);
      save(file, { ...record, status: reason === "cancelled" ? "stopped" : reason === "timeout" ? "failed" : code === 0 ? "succeeded" : "failed", exitCode: reason === "timeout" ? 124 : reason === "cancelled" ? 143 : code, finishedAt: Date.now() });
      fs.closeSync(log);
    };
    try {
      child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", log, log] });
      record.pid = child.pid;
      record.pidStart = child.pid ? processInfo(child.pid)?.start : undefined;
      capture();
      if (cancellationRequested) stop("cancelled");
      child.on("error", () => { void finish(127); });
      child.on("exit", (code) => { void finish(code ?? 1); });
    } catch { await finish(127); }
    return;
  }
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(STATE + "/processes", { recursive: true, mode: 0o700 });
  fs.mkdirSync(STATE + "/staging", { recursive: true, mode: 0o700 });
  const manifestFile = STATE + "/manifest.json";
  const pendingFile = STATE + "/pending.json";
  const manifest = () => exists(manifestFile) ? json(manifestFile) : { revision: null, files: [] };
  const pending = () => exists(pendingFile) ? json(pendingFile) : null;
  const processRecord = (id) => {
    const record = json(recordPath(id));
    if (record.status === "running") {
      const runner = processInfo(record.runnerPid);
      if (!runner || runner.state === "Z" || (record.runnerStart && runner.start !== record.runnerStart)) {
        record.owned = ownedProcesses(record);
        signalOwned(record.owned, "SIGKILL");
        // Keep the slot occupied until every owned process is actually gone.
        if (!record.owned.length) {
          record.status = "failed"; record.finishedAt = Date.now(); record.exitCode = 255;
        }
        save(recordPath(record.id), record);
      }
    }
    const { pid, pidStart, runnerPid, runnerStart, owned, ...publicRecord } = record;
    return publicRecord;
  };
  // Logs are lifetime-stable identities: launch publishes state, then the log,
  // before releasing runner stdin. Runners only append/close logs; neither
  // running nor terminal records remove them. Never enumerate replaced JSON.
  const processes = () => fs.readdirSync(STATE + "/processes").filter((p) => p.endsWith(".log")).map((p) => processRecord(p.slice(0, -4)));
  const body = async (req, max = 32 * 1024 * 1024) => {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > max) fail("Request too large", 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("Invalid JSON"); }
  };
  const reply = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
  const stagePath = (path) => STATE + "/staging/" + crypto.createHash("sha256").update(path).digest("hex");
  let busy = false;
  const uploads = new Set();
  const handle = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/ownership" && req.method === "POST") {
      const value = await body(req, 1024 * 1024);
      const response = await fetch(process.env.REMOTE_ORIGIN + "/__remote/ownership", { method: "POST", headers: { "authorization": "Bearer " + process.env.OWNERSHIP_TOKEN, "content-type": "application/json" }, body: JSON.stringify(value) });
      if (!response.ok) fail("Unable to persist resource ownership", 502);
      return reply(res, { ok: true });
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const expected = process.env.RUNTIME_TOKEN ?? "";
    if (!expected || token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) fail("Unauthorized", 401);
    if (Date.now() >= Number(process.env.EXPIRES_AT)) fail("Workspace expired", 410);
    const route = url.pathname;
    if (req.method === "GET" && route === "/status") return reply(res, { running: true, expiresAt: Number(process.env.EXPIRES_AT), processes: processes(), sourceRevision: manifest().revision, inspectorBridgePort: 9230 });
    if (req.method === "GET" && route === "/sync") return reply(res, manifest());
    if (req.method === "GET" && route === "/artifacts") {
      const path = url.searchParams.get("path");
      safe(path, false);
      if (!(path.startsWith(".gitmatrix-agent/artifacts/") || /^\.gitmatrix-agent\/runs\/[^/]+\/artifacts\//.test(path) || path === "apps/cli/target/debug/gm" || path === "apps/cli/target/release/gm")) fail("Not an artifact path", 403);
      const target = anchored(path, false, false);
      try {
        const fd = fs.openSync(target.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) { fs.closeSync(fd); fail("Not a regular artifact"); }
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": stat.size, "cache-control": "no-store" });
        await pipeline(fs.createReadStream(null, { fd, autoClose: true }), res);
      } finally { target.close(); }
      return;
    }
    const match = /^\/processes\/([a-zA-Z0-9_-]{1,80})(?:\/(logs|stop))?$/.exec(route);
    if (match && req.method === "GET") {
      if (!exists(recordPath(match[1]))) fail("Unknown process", 404);
      const record = processRecord(match[1]);
      if (!match[2]) return reply(res, record);
      if (match[2] === "logs") {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        if (!Number.isSafeInteger(offset) || offset < 0) fail("Invalid log offset");
        const fd = fs.openSync(STATE + "/processes/" + match[1] + ".log", "r");
        try {
          const bytes = Buffer.alloc(64 * 1024);
          let read = fs.readSync(fd, bytes, 0, bytes.length, offset);
          // Do not split a UTF-8 codepoint across log responses.
          if (read && (record.status === "running" || offset + read < fs.fstatSync(fd).size)) {
            let lead = read - 1;
            while (lead > 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
            const first = bytes[lead];
            const needed = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
            if (read - lead < needed) read = lead;
          }
          const nextOffset = offset + read;
          return reply(res, { text: bytes.subarray(0, read).toString("utf8"), nextOffset, done: record.status !== "running" && nextOffset >= fs.fstatSync(fd).size, ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }) });
        } finally { fs.closeSync(fd); }
      }
    }
    if (busy || (req.method !== "PUT" && uploads.size)) fail("Another workspace mutation is in progress", 409);
    const uploadKey = req.method === "PUT" ? url.searchParams.get("path") : null;
    if (uploadKey !== null) {
      if (uploads.has(uploadKey)) fail("File upload already in progress", 409);
      uploads.add(uploadKey);
    } else busy = true;
    try {
      if (route === "/sync" && req.method === "POST") {
        if (processes().some((record) => record.kind === "foreground" && record.status === "running")) fail("A foreground command is using this source snapshot", 409);
        const spec = await body(req);
        if (!spec || !/^[a-f0-9]{64}$/.test(spec.revision) || !Array.isArray(spec.files) || spec.files.length > 100000 || !Array.isArray(spec.deleted)) fail("Invalid manifest");
        const paths = new Set(); let total = 0;
        for (const file of spec.files) {
          safe(file.path);
          if (paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE || ![0o644, 0o755].includes(file.mode)) fail("Invalid manifest entry");
          paths.add(file.path); total += file.size;
        }
        for (const path of paths) {
          let parent = path;
          while (parent.includes("/")) { parent = parent.slice(0, parent.lastIndexOf("/")); if (paths.has(parent)) fail("Manifest file is also a directory"); }
        }
        if (total > 1024 * 1024 * 1024) fail("Source snapshot too large", 413);
        const current = manifest(); const existing = pending();
        if (spec.baseRevision !== current.revision) fail("Source revision conflict", 409);
        const prior = new Map(current.files.map((file) => [file.path, file]));
        const deleted = new Set(spec.deleted);
        if (deleted.size !== spec.deleted.length) fail("Duplicate deletion");
        for (const path of deleted) { safe(path); if (!prior.has(path) || paths.has(path)) fail("Deletion is not a previously managed source path"); }
        for (const path of prior.keys()) if (!paths.has(path) && !deleted.has(path)) fail("Manifest omission requires explicit deletion");
        const replacing = existing && JSON.stringify(existing.spec) !== JSON.stringify(spec);
        const dirty = Boolean(existing?.dirty || existing?.committing);
        const upload = spec.files.filter((file) => { const old = prior.get(file.path); return dirty || !old || old.sha256 !== file.sha256 || old.mode !== file.mode || old.size !== file.size; }).map((file) => file.path);
        const abandoned = replacing && dirty ? [...new Set([...existing.upload, ...(existing.abandoned ?? [])])].filter((path) => !paths.has(path) && !deleted.has(path)) : [];
        const transaction = existing && !replacing ? existing : { spec, upload, received: [], abandoned, dirty };
        save(pendingFile, transaction);
        return reply(res, { upload: transaction.upload.filter((path) => !transaction.received.includes(path)) });
      }
      if (route === "/files" && req.method === "PUT") {
        const transaction = pending(); const path = url.searchParams.get("path");
        if (!transaction || transaction.spec.revision !== url.searchParams.get("revision")) fail("No matching sync transaction", 409);
        const file = transaction.spec.files.find((file) => file.path === path);
        if (!file || !transaction.upload.includes(path)) fail("File not requested", 409);
        safe(path);
        const temporary = stagePath(path) + ".upload";
        const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
        let size = 0; const hash = crypto.createHash("sha256");
        try {
          for await (const chunk of req) {
            size += chunk.length; if (size > file.size || size > MAX_FILE) fail("File exceeds declared size", 413);
            hash.update(chunk); let offset = 0; while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset);
          }
          if (size !== file.size || hash.digest("hex") !== file.sha256) fail("File digest or size mismatch", 422);
          fs.fchmodSync(fd, file.mode);
        } catch (error) { fs.rmSync(temporary, { force: true }); throw error; } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, stagePath(path));
        const latest = pending();
        if (!latest || latest.spec.revision !== transaction.spec.revision) fail("Sync transaction changed", 409);
        if (!latest.received.includes(path)) latest.received.push(path);
        save(pendingFile, latest);
        return reply(res, { ok: true });
      }
      if (route === "/sync/commit" && req.method === "POST") {
        const spec = await body(req, 4096); const transaction = pending();
        if (!transaction && manifest().revision === spec.revision) return reply(res, { revision: spec.revision });
        if (!transaction || transaction.spec.revision !== spec.revision) fail("No matching sync transaction", 409);
        if (transaction.upload.some((path) => !transaction.received.includes(path))) fail("Source files are missing", 409);
        transaction.committing = true;
        save(pendingFile, transaction);
        for (const path of [...transaction.spec.deleted, ...(transaction.abandoned ?? [])]) {
          let target;
          try {
            target = anchored(path);
            const stat = fs.lstatSync(target.path);
            if (stat.isDirectory() && transaction.spec.files.some((file) => file.path.startsWith(path + "/"))) continue;
            if (!stat.isFile()) fail("Deletion target changed type");
            fs.unlinkSync(target.path);
          } catch (e) {
            const replacedParent = e.code === "ENOTDIR" && transaction.spec.files.some((file) => path.startsWith(file.path + "/"));
            if (e.code !== "ENOENT" && !replacedParent) throw e;
          } finally { target?.close(); }
          let parent = path;
          while (parent.includes("/")) {
            parent = parent.slice(0, parent.lastIndexOf("/"));
            let directory;
            try { directory = anchored(parent); fs.rmdirSync(directory.path); }
            catch (e) { if (!["ENOENT", "ENOTEMPTY", "ENOTDIR"].includes(e.code)) throw e; break; }
            finally { directory?.close(); }
          }
        }
        // Keep staging files until the manifest commits, so a partial commit is replayable.
        for (const path of transaction.upload) {
          const target = anchored(path, true);
          try {
            try { if (!fs.lstatSync(target.path).isFile()) fail("Source target is not a regular file"); } catch (e) { if (e.code !== "ENOENT") throw e; }
            const temporary = target.path + ".remote-" + crypto.randomUUID();
            fs.copyFileSync(stagePath(path), temporary, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(temporary, transaction.spec.files.find((file) => file.path === path).mode);
            fs.renameSync(temporary, target.path);
          } finally { target.close(); }
        }
        save(manifestFile, { revision: spec.revision, files: transaction.spec.files });
        fs.unlinkSync(pendingFile);
        for (const path of transaction.upload) fs.rmSync(stagePath(path), { force: true });
        return reply(res, { revision: spec.revision });
      }
      if (route === "/credentials" && req.method === "POST") {
        const spec = await body(req, 65536); const env = checkedEnv(spec.env);
        if (Object.keys(env).some((key) => !["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].includes(key))) fail("Invalid credential channel");
        save(STATE + "/credentials.json", { env });
        return reply(res, { ok: true });
      }
      if (route === "/commands" && req.method === "POST") {
        const spec = await body(req, 128 * 1024); validId(spec.id);
        if (exists(recordPath(spec.id))) return reply(res, { id: spec.id });
        if (pending()) fail("Source synchronization is incomplete", 409);
        if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.length > 256 || spec.argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 32768)) fail("Invalid argv");
        spec.kind ??= "foreground";
        if (!["foreground", "app", "debug"].includes(spec.kind)) fail("Invalid command kind");
        if (processes().some((p) => p.kind === spec.kind && p.status === "running")) fail("Command concurrency limit reached", 409);
        spec.cwd ??= ROOT;
        if (spec.cwd === ".") spec.cwd = ROOT;
        if (spec.cwd !== ROOT) {
          const relative = spec.cwd.startsWith(ROOT + "/") ? spec.cwd.slice(ROOT.length + 1) : spec.cwd;
          const target = anchored(relative + "/.cwd", false, false);
          try { spec.cwd = fs.realpathSync(target.path.slice(0, target.path.lastIndexOf("/"))); } finally { target.close(); }
          if (spec.cwd !== ROOT && !spec.cwd.startsWith(ROOT + "/")) fail("Invalid working directory");
        }
        spec.env = { ...BASE, GITMATRIX_REMOTE_ORIGIN: process.env.REMOTE_ORIGIN, ...(exists(STATE + "/credentials.json") ? json(STATE + "/credentials.json").env : {}), ...checkedEnv(spec.env) };
        const remaining = Number(process.env.EXPIRES_AT) - Date.now();
        if (spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 86400000)) fail("Invalid command timeout");
        spec.timeoutMs = Math.min(spec.timeoutMs ?? remaining, remaining);
        const runner = spawn(process.execPath, [STATE + "/runtime.mjs", "runner", spec.id], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: BASE });
        save(recordPath(spec.id), { id: spec.id, kind: spec.kind, status: "running", startedAt: Date.now(), runnerPid: runner.pid, runnerStart: runner.pid ? processInfo(runner.pid)?.start : undefined });
        fs.closeSync(fs.openSync(STATE + "/processes/" + spec.id + ".log", "a", 0o600));
        const launched = Promise.withResolvers();
        runner.once("error", launched.reject); runner.stdin.end(JSON.stringify(spec), launched.resolve);
        await launched.promise;
        runner.unref();
        return reply(res, { id: spec.id });
      }
      if (match?.[2] === "stop" && req.method === "POST") {
        if (!exists(recordPath(match[1]))) fail("Unknown process", 404);
        const record = json(recordPath(match[1]));
        if (record.status === "running") {
          try {
            const args = fs.readFileSync("/proc/" + record.runnerPid + "/cmdline", "utf8").split("\0");
            if (args[1] !== STATE + "/runtime.mjs" || args[2] !== "runner" || args[3] !== record.id) fail("Process ownership no longer matches", 409);
            process.kill(record.runnerPid, "SIGTERM");
          } catch (e) {
            if (!["ESRCH", "ENOENT"].includes(e.code)) throw e;
          }
          for (const deadline = Date.now() + 35_000; processRecord(record.id).status === "running";) {
            if (Date.now() >= deadline) fail("Process has not stopped", 503);
            await sleep(25);
          }
        }
        return reply(res, { ok: true });
      }
      fail("Unknown endpoint", 404);
    } finally { if (uploadKey !== null) uploads.delete(uploadKey); else busy = false; }
  };
  // workerd's inspector is loopback-only. Only the control-authenticated Worker
  // route reaches this private container port; raw piping preserves WebSockets.
  const inspectorBridge = net.createServer((client) => {
    const upstream = net.connect({ host: "127.0.0.1", port: 9229 });
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  inspectorBridge.maxConnections = 32;
  const bridgeReady = Promise.withResolvers();
  inspectorBridge.once("error", bridgeReady.reject);
  inspectorBridge.listen(9230, "0.0.0.0", bridgeReady.resolve);
  await bridgeReady.promise;
  http.createServer((req, res) => { handle(req, res).catch((error) => { if (!res.headersSent) reply(res, { error: error.status ? error.message : "Runtime operation failed", code: error.code }, error.status ?? 500); else res.destroy(); }); }).listen(8787, "0.0.0.0");
})().catch((error) => {
  let message = String(error).slice(0, 2048);
  for (const key of ["RUNTIME_TOKEN", "OWNERSHIP_TOKEN"]) if (process.env[key]) message = message.split(process.env[key]).join("[redacted]");
  process.stderr.write(message + "\n");
  process.exit(1);
});`;

// Executed under flock. Controller source arrives over native exec stdin, never
// through an environment variable (the platform caps individual values at 16KB).
export const bootstrapSource = String.raw`
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const state = "/workspace/.remote";
const runtimePath = state + "/runtime.mjs";
const logPath = state + "/bootstrap.log";
const pidPath = state + "/controller.json";
const healthy = async () => {
  try {
    const response = await fetch("http://127.0.0.1:8787/status", {
      headers: { authorization: "Bearer " + process.env.RUNTIME_TOKEN },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const status = await response.json();
    if (status.inspectorBridgePort !== 9230) throw new Error("Controller update requires stopping and restarting the workspace");
    return true;
  } catch (error) {
    if (error.message === "Controller update requires stopping and restarting the workspace") throw error;
    return false;
  }
};
const identity = (pid) => {
  const args = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0").filter(Boolean);
  if (args.length !== 2 || args[1] !== runtimePath) return null;
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};
const running = () => {
  try { const record = JSON.parse(fs.readFileSync(pidPath, "utf8")); return identity(record.pid) === record.birth; }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
};
try {
  if (!await healthy()) {
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    if (!running()) {
      const temporary = runtimePath + ".new";
      fs.writeFileSync(temporary, runtimeSource, { mode: 0o600 });
      fs.renameSync(temporary, runtimePath);
      const log = fs.openSync(logPath, "w", 0o600);
      const child = spawn(process.execPath, [runtimePath], {
        detached: true, stdio: ["ignore", log, log], env: process.env,
      });
      const launched = Promise.withResolvers();
      child.once("spawn", launched.resolve);
      child.once("error", launched.reject);
      try { await launched.promise; } finally { fs.closeSync(log); }
      child.unref();
      const birth = identity(child.pid);
      if (!birth) throw new Error("Controller process identity was not established");
      fs.writeFileSync(pidPath, JSON.stringify({ pid: child.pid, birth }), { mode: 0o600 });
    }
    const deadline = Math.min(Date.now() + 15000, Number(process.env.EXPIRES_AT));
    while (!await healthy()) {
      if (!running()) throw new Error("Controller exited during bootstrap");
      if (Date.now() >= deadline) throw new Error("Controller did not become ready");
      await sleep(100);
    }
  }
  process.stdout.write('{"ready":true}\n');
} catch (error) {
  let diagnostic = String(error).slice(0, 2048);
  try {
    const fd = fs.openSync(logPath, "r");
    try { const bytes = Buffer.alloc(4096); const count = fs.readSync(fd, bytes); diagnostic += "\n" + bytes.subarray(0, count).toString("utf8"); }
    finally { fs.closeSync(fd); }
  } catch {}
  for (const key of ["RUNTIME_TOKEN", "OWNERSHIP_TOKEN"]) if (process.env[key]) diagnostic = diagnostic.split(process.env[key]).join("[redacted]");
  process.stderr.write(diagnostic);
  process.exitCode = 1;
}
`;
