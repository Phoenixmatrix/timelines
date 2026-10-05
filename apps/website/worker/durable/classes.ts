// Every Durable Object class the Worker exports (cloudflare.config.ts), with
// how its instances are named and who owns them (CORE-197). The conformance
// test fails when a class exported from the config is missing here, when one
// lacks the purge contract, or when code reaches a namespace without going
// through worker/durable/registry.ts.

export interface DurableClassInfo {
  /** The binding in cloudflare.config.ts's env that reaches the class. */
  binding: string;
  /** The class's source, relative to apps/website (the conformance test reads it). */
  source: string;
  /** The account and repository an instance belongs to, from its name alone. */
  owner(name: string): { account: string | null; repo: string | null };
  /**
   * Cleans itself up with an alarm when its short-lived work ends (registry
   * uploads and logins). Registered like the others, but never sized, and
   * the cron forgets its rows a day after their last use.
   */
  selfCleaning?: boolean;
  /** Keeps no storage of its own (sizing would only wake it). */
  stateless?: boolean;
}

const none = { account: null, repo: null };

export const DURABLE_CLASSES = {
  /** One per account: its issues, timelines and events. Named by account id. */
  Tracker: {
    binding: "TRACKER",
    source: "worker/tracker/object.ts",
    owner: (name: string) => ({ account: name, repo: null }),
  },
  /** One per conversation, "<userId>:<chatId>". */
  Assistant: {
    binding: "ASSISTANT",
    source: "worker/assistant/agent.ts",
    owner: (name: string) => ({ account: name.split(":")[0] || null, repo: null }),
  },
  /** One per repository, named by repository id. */
  KnowledgeCoordinator: {
    binding: "KNOWLEDGE_COORDINATOR",
    source: "worker/knowledge/coordinator.ts",
    owner: (name: string) => ({ account: null, repo: name }),
  },
  /** One per repository and timeline, "<repoId>:<slug>": its live feed of steps (CORE-239). */
  StepFeed: {
    binding: "STEP_FEED",
    source: "worker/steps/feed.ts",
    owner: (name: string) => ({ account: null, repo: name.split(":")[0] || null }),
  },
  /** One per CI job, named by job id; owns the job's container while it runs. */
  CiSandbox: {
    binding: "CI_SANDBOX",
    source: "worker/ci/sandbox.ts",
    owner: () => none,
    stateless: true,
  },
  /** One per registry repository, named by its id in the registry's database. */
  RegistryRepo: {
    binding: "REGISTRY_REPO",
    source: "registry/do/repo-do.ts",
    owner: () => none,
  },
  /** One per OCI blob upload session, named by its uuid. */
  RegistryUpload: {
    binding: "REGISTRY_UPLOAD",
    source: "registry/do/upload-do.ts",
    owner: () => none,
    selfCleaning: true,
  },
  /** One per pending CLI web login. */
  RegistryLogin: {
    binding: "REGISTRY_LOGIN",
    source: "registry/do/login-do.ts",
    owner: () => none,
    selfCleaning: true,
  },
} satisfies Record<string, DurableClassInfo>;

export type DurableClass = keyof typeof DURABLE_CLASSES;

export const DURABLE_CLASS_NAMES = Object.keys(DURABLE_CLASSES) as DurableClass[];

export function durableClass(name: string): DurableClassInfo | undefined {
  return (DURABLE_CLASSES as Record<string, DurableClassInfo>)[name];
}
