// The assistant: one Durable Object per conversation, named "<userId>:<chatId>"
// (the API checks the user before routing here, see api/assistant.ts). The
// transcript persists in its SQLite (AIChatAgent); the directory of chats is
// in D1 (assistant_chats).
//
// A turn: clef-flash plans it (plan.ts) while the client already shows a
// status; the plan picks the model, reasoning, tool groups, preloaded skills
// and whether Code Mode is offered; then the orchestrator streams with tools
// that call the real API as the person's assistant agent (identity.ts).

import { AsyncLocalStorage } from "node:async_hooks";
import { DurableObject } from "cloudflare:workers";
import {
  trackedContext,
  withCutoverAdmission,
  withCutoverAlarmAdmission,
} from "../durable/cutover-admission.ts";
import { reportCutoverRuntime } from "../durable/cutover-runtime.ts";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type ToolSet,
  type UIMessage,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { toolLabel, type AskEvent, type PageContext } from "../../shared/assistant.ts";
import { aiGatewayOptions } from "../ai-gateway.ts";
import { app } from "../app.ts";
import { decide } from "../knowledge/models.ts";
import { db, nowIso } from "../schema.ts";
import type { Actor } from "../db.ts";
import { isActorCredentialLive } from "../auth.ts";
import {
  AssistantContentUnavailable,
  authorizeReceipts,
  contentProbe,
  contentReceipt,
  type ContentReceipt,
} from "./provenance.ts";
import {
  confirmPurged,
  RETIRE_DELAY_MS,
  storageReport,
  type Purgeable,
  type PurgeReport,
} from "../durable/contract.ts";
import { recordPurge } from "../durable/record.ts";
import { credential, type AssistantCredential } from "./identity.ts";
import { assistantCapacity } from "./capacity.ts";
import { apiClient, type CallApi } from "./internal.ts";
import { clefState, planFrom, questions, type TurnPlan } from "./plan.ts";
import {
  cleanStatus,
  PROGRESS_INSTRUCTIONS,
  progressPrompt,
  stepFromMessage,
  WORKING,
  type ProgressStep,
} from "./progress.ts";
import { sentenceCase } from "./titles.ts";
import { buildSkillRegistry, preloaded, resolveSkillInvocation, skillReceipt } from "./skills.ts";
import { buildTools } from "./tools.ts";
import { aiWork, recordAiCall, type AiTokens, type AiWork } from "../usage/ai.ts";

/** Models by job. All Workers AI; see the CORE-25 notes for why each. */
export const ASSISTANT_MODELS = {
  /** Most turns: fast, 1M context, reliable tool calls, cheap ($0.15/M in). */
  fast: "@cf/zai-org/glm-5.3-flash",
  /** Hard or long turns clef rates 3+, and planning. */
  deep: "@cf/zai-org/glm-5.3",
  /** Chat titles: a few words, the cheapest capable model. */
  title: "@cf/ibm-granite/granite-4.0-h-micro",
  /** Mid-turn status lines: a few words, as fast as possible (progress.ts). */
  status: "@cf/ibm-granite/granite-4.0-h-micro",
} as const;

/** clef must answer fast or not at all: a turn never waits on routing. */
const PLAN_DEADLINE_MS = 2500;
/** A status that arrives later than this would describe a step already under way. */
const STATUS_DEADLINE_MS = 4000;

export interface CliTurn {
  write: boolean;
  repo?: string;
  /** The agent that asked, when a coding agent ran `gm ask` (CORE-222). */
  agent?: string;
  emit: (event: AskEvent) => Promise<void>;
}

function text(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

function instructions(options: {
  person: string;
  page: PageContext | null;
  repo: string | null;
  plan: TurnPlan;
  skills: string;
  web: boolean;
}): string {
  const { page } = options;
  const where = page
    ? [
        `The person is looking at ${page.path}${page.title ? ` (“${page.title}”)` : ""}.`,
        page.repo && `Repository: ${page.repo}${page.ref ? ` at ${page.ref}` : ""}.`,
        page.file && `File: ${page.file}${page.lines ? `, lines ${page.lines} selected` : ""}.`,
        page.issue && `Issue: ${page.issue} in ${page.tracker}'s tracker.`,
        page.run && `CI run #${page.run}.`,
        options.plan.aboutPage &&
          "Their message is about what's on screen: “this”, “here” and “it” mean it.",
      ]
        .filter(Boolean)
        .join(" ")
    : options.repo
      ? `The question is about the repository ${options.repo}.`
      : "";
  return `You are the Timelines assistant, working for ${options.person}. Timelines is a git host for agent-driven development: repositories with a knowledge graph and wiki, CI, a package registry, and a dependency-aware issue tracker.

You act as ${options.person}'s assistant agent, with their permissions. Everything you change is recorded as yours, for them.

How to work:
- Use tools to find out; never guess at code, issues, runs or packages. If something isn't reachable, say what you tried.
- Be brief and concrete. Lead with the answer. Use Markdown; cite code with links to exact lines.
- Link everything you mention with Space-qualified app paths, e.g. [CORE-25](/tracker/matrixorg/issues/CORE-25), [run #44](/space/repo/ci/44), [worker/app.ts:12](/space/repo/blob/main/worker/app.ts#L12).
- Use the navigation skill's browser routes for links and navigate. API endpoint names are not page URLs; never derive a browser link by dropping /api or /repos from an API path.
${
  options.web
    ? `- Writes (creating or changing issues, comments, reruns, settings…) each wait for the person to approve a card that shows exactly what will happen. Call the tool directly: the card is the confirmation, so don't ask in words first, and never claim a change happened before its tool returns.
- Approval and refusal are scoped to the specific tool call. Read their status from the conversation's approval and tool results, not from item names or inferred history. A new explicit request needs its own approval card; never retry a declined call unless the person explicitly asks again.
- Use navigate to open a page beside this chat when they ask to see or go somewhere, or to show what you just made.`
    : `- You're answering from a terminal (gm ask). ${options.plan.intent === "act" ? "" : ""}If a change is needed and you have no write tools, say exactly what to do (the gm command or page).`
}
- Never ask for, repeat or store secret values. For credentials, tell the person where to set them.
- Tools that list things cap their output; narrow the query rather than paging blindly.

${where}

${options.skills}`.trim();
}

/** The AI SDK's usage, as metering records it. */
function usageTokens(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
): AiTokens {
  return { input: usage?.inputTokens, output: usage?.outputTokens, total: usage?.totalTokens };
}

/** A turn this recent counts as in progress even before it streams (purgeIfIdle). */
export const TURN_GRACE_MS = 10 * 60_000;

interface AssistantAdmission {
  context: DurableObjectState;
  open: boolean;
  releaseSettled: boolean;
  reset?: () => void;
}

/**
 * Keep the SDK constructor behind admission too: AIChatAgent initializes SQL
 * synchronously, and its startup/WS dispatch writes before user lifecycle hooks.
 * The binding remains Assistant; the SDK shares this object's exact storage,
 * identity and sockets and is constructed only after independent admission.
 */
export class Assistant extends DurableObject<Env> implements Purgeable {
  #agent: AssistantSession | undefined;
  #scope = new AsyncLocalStorage<AssistantAdmission>();
  #platformContext: DurableObjectState;

  // Probe the real DO runtime without constructing or starting the SDK session.
  cutoverRuntime(runId: string) {
    return reportCutoverRuntime(this.env, runId, "assistant");
  }

  static {
    // Preserve the installed SDK's native RPC/callback surface, including
    // _cf_routeLifecycle and recovery callbacks, without an incomplete copied
    // allowlist. Resolve the final SDK instance method after construction so its
    // onMessage/onStart wrappers (not just prototype hooks) run inside admission.
    for (
      let prototype = AIChatAgent.prototype;
      prototype && prototype !== DurableObject.prototype;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      for (const [name, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(prototype),
      )) {
        if (name === "constructor" || Object.hasOwn(this.prototype, name)) continue;
        if (typeof descriptor.value === "function") {
          Object.defineProperty(this.prototype, name, {
            configurable: true,
            value: function (this: Assistant, ...args: unknown[]) {
              return this.#dispatch(name, args);
            },
          });
        } else if (descriptor.get) {
          Object.defineProperty(this.prototype, name, {
            configurable: true,
            get: function (this: Assistant) {
              return this.#invoke(async (agent) => Reflect.get(agent, name, agent));
            },
          });
        }
      }
    }
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const nativeStorage = ctx.storage;
    const nativeWaitUntil = ctx.waitUntil.bind(ctx);
    const nativeAbort = ctx.abort.bind(ctx);
    const sql = new Proxy(ctx.storage.sql, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          this.#admission();
          return Reflect.apply(value, target, args);
        };
      },
    });
    let kv: object | undefined;
    const storage = new Proxy(ctx.storage, {
      get: (target, key) => {
        if (key === "sql") return sql;
        if (key === "kv") {
          this.#admission();
          return (kv ??= new Proxy(Reflect.get(target, key, target), {
            get: (target, key) => {
              const value = Reflect.get(target, key, target);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                this.#admission();
                return Reflect.apply(value, target, args);
              };
            },
          }));
        }
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const admission = this.#admission();
          const result = Reflect.apply(value, target, args);
          // The SDK has storage callbacks that intentionally don't await puts.
          // Track those as well as waitUntil before allowing the ticket to end.
          if (result instanceof Promise) admission.context.waitUntil(result);
          return result;
        };
      },
    });
    // DurableObjectBase checks the native state brand: a Proxy cannot be passed
    // to super(). Decorate the genuine state before SDK construction instead.
    // Only this facade retains unguarded members for admission/lease cleanup.
    this.#platformContext = new Proxy(ctx, {
      get: (target, key) => {
        if (key === "storage") return nativeStorage;
        if (key === "waitUntil") return nativeWaitUntil;
        if (key === "abort") return nativeAbort;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Object.defineProperties(ctx, {
      storage: { configurable: true, value: storage },
      waitUntil: {
        configurable: true,
        value: (work: Promise<unknown>) => this.#admission().context.waitUntil(work),
      },
      abort: {
        configurable: true,
        value: (...args: Parameters<DurableObjectState["abort"]>) => {
          const scope = this.#scope.getStore();
          if (!scope)
            throw new Error("space_cutover_fenced: assistant reset has no admission origin");
          const reset = () => {
            nativeAbort(...args);
          };
          // SDK destroy/circuit-breaker resets run on a timer. Do not let that
          // timer kill the isolate while its normal ticket release is in flight.
          if (scope.releaseSettled) reset();
          else scope.reset = reset;
        },
      },
    });
  }

  #admission() {
    const scope = this.#scope.getStore();
    if (!scope?.open)
      throw new Error("space_cutover_fenced: assistant callback has no live admission");
    return scope;
  }

  async #invoke<T>(
    work: (agent: AssistantSession) => Promise<T>,
    publish?: (result: T) => void,
  ): Promise<T> {
    let scope: AssistantAdmission | undefined;
    try {
      return await withCutoverAdmission(this.env, "assistant", () =>
        this.#execute(work, publish, (current) => {
          scope = current;
        }),
      );
    } finally {
      this.#releaseFinished(scope);
    }
  }

  #releaseFinished(scope?: AssistantAdmission) {
    if (!scope) return;
    scope.releaseSettled = true;
    if (scope.reset) setTimeout(scope.reset, 0);
  }

  async #execute<T>(
    work: (agent: AssistantSession) => Promise<T>,
    publish?: (result: T) => void,
    capture?: (scope: AssistantAdmission) => void,
  ): Promise<T> {
    const tracked = trackedContext(this.#platformContext);
    const scope: AssistantAdmission = {
      context: tracked.context,
      open: true,
      releaseSettled: false,
    };
    capture?.(scope);
    return this.#scope.run(scope, async () => {
      try {
        this.#agent ??= new AssistantSession(this.ctx, this.env, () => {
          this.#admission();
        });
        const result = await work(this.#agent);
        publish?.(result);
        return result;
      } finally {
        try {
          await tracked.settle();
        } finally {
          scope.open = false;
        }
      }
    });
  }

  #stream(stream: ReadableStream<Uint8Array>) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.#admission().context.waitUntil(stream.pipeTo(writable));
    return readable;
  }

  #dispatch(name: string, args: unknown[]) {
    const reply = Promise.withResolvers<unknown>();
    this.#platformContext.waitUntil(
      this.#invoke(async (agent) => {
        const result = await Reflect.apply(Reflect.get(agent, name, agent), agent, args);
        if (result instanceof Response && result.body && result.status !== 101)
          return new Response(this.#stream(result.body), result);
        if (result instanceof ReadableStream) return this.#stream(result);
        return result;
      }, reply.resolve).catch((error) => {
        reply.reject(error);
        throw error;
      }),
    );
    return reply.promise;
  }

  // getAgentByName's initialization contract, including persisted SDK recovery.
  __unsafe_ensureInitialized(props?: object) {
    return this.#invoke((agent) => agent.__unsafe_ensureInitialized(props));
  }

  override fetch(request: Request): Promise<Response> {
    const reply = Promise.withResolvers<Response>();
    this.#platformContext.waitUntil(
      this.#invoke(async (agent) => {
        const response = await agent.authorizedFetch(request);
        if (!response.body || response.status === 101) return response;
        return new Response(this.#stream(response.body), response);
      }, reply.resolve).catch((error) => {
        reply.reject(error);
        throw error;
      }),
    );
    return reply.promise;
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    return this.#invoke((agent) => agent.authorizedSocket(socket, message));
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean) {
    return this.#invoke((agent) => agent.lifecycle.webSocketClose(socket, code, reason, wasClean));
  }

  override webSocketError(socket: WebSocket, error: unknown) {
    return this.#invoke((agent) => agent.lifecycle.webSocketError(socket, error));
  }

  override async alarm() {
    let scope: AssistantAdmission | undefined;
    try {
      await withCutoverAlarmAdmission(this.env, "assistant", this.#platformContext.storage, () =>
        this.#execute(
          (agent) => agent.alarm(),
          undefined,
          (current) => {
            scope = current;
          },
        ),
      );
    } finally {
      this.#releaseFinished(scope);
    }
  }

  ask(question: string, options: { actor: Actor; write: boolean; repo?: string; url: string }) {
    const reply = Promise.withResolvers<ReadableStream<Uint8Array>>();
    this.#platformContext.waitUntil(
      this.#invoke(
        async (agent) => this.#stream(await agent.ask(question, options)),
        reply.resolve,
      ).catch((error) => {
        reply.reject(error);
        throw error;
      }),
    );
    return reply.promise;
  }

  transcript(actor: Actor) {
    return this.#invoke((agent) => agent.withActor(actor, () => agent.transcript()));
  }

  exportTranscript(actor: Actor) {
    return this.#invoke((agent) =>
      agent.withActor(actor, async () => {
        if (actor.agent)
          throw new Error("Sign in as the owning person to export this conversation.");
        await agent.authorizeContent();
        return JSON.stringify({
          contractVersion: 4,
          ...agent.owner,
          messages: agent.messages,
          contentReceipts:
            (await this.ctx.storage.get<ContentReceipt[]>("content-receipts-v4")) ?? null,
        });
      }),
    );
  }

  async canReadTranscript(actor: Actor) {
    try {
      await this.#invoke((agent) => agent.withActor(actor, () => agent.authorizeContent()));
      return true;
    } catch {
      return false;
    }
  }

  purge(reason: string) {
    return this.#invoke((agent) => agent.purge(reason));
  }

  purgeIfIdle(reason: string) {
    return this.#invoke((agent) => agent.purgeIfIdle(reason));
  }

  retire(reason: string, name: string, delayMs?: number) {
    return this.#invoke((agent) => agent.retire(reason, name, delayMs));
  }

  retireNow(input: { reason: string; name: string }) {
    return this.#invoke((agent) => agent.retireNow(input));
  }

  storageReport() {
    return this.#invoke((agent) => agent.storageReport());
  }
}

type AssistantSession = InstanceType<typeof AssistantSession>;
// SDK protocol identity derives from constructor.name; keep "Assistant".
const AssistantSession = class Assistant extends AIChatAgent<Env> implements Purgeable {
  maxPersistedMessages = 500;
  private credential: AssistantCredential | null = null;
  /** Set while a `gm ask` turn runs (programmatic turns carry no request body). */
  private cli: CliTurn | null = null;
  /** When the latest turn started (ms), for purgeIfIdle. */
  #turnAt = 0;
  #assertAdmission: () => void;
  #actors = new AsyncLocalStorage<Actor>();

  async withActor<T>(actor: Actor, work: () => Promise<T>): Promise<T> {
    if (actor.id !== this.owner.userId || !(await isActorCredentialLive(this.env.DB, actor)))
      throw new AssistantContentUnavailable();
    return this.#actors.run(actor, work);
  }

  async authorizedFetch(request: Request): Promise<Response> {
    const encoded = request.headers.get("X-Gitmatrix-Assistant-Actor");
    if (!encoded) return new Response("Authentication required", { status: 401 });
    const actor = JSON.parse(encoded) as Actor;
    try {
      return await this.withActor(actor, async () => {
        await this.authorizeContent();
        return super.fetch(request);
      });
    } catch (error) {
      if (!(error instanceof AssistantContentUnavailable)) throw error;
      return Response.json(
        { error: error.message, code: "assistant_content_unavailable" },
        { status: 403 },
      );
    }
  }

  override async onConnect(...args: Parameters<AIChatAgent<Env>["onConnect"]>) {
    const actor = this.#actors.getStore();
    if (!actor) throw new AssistantContentUnavailable();
    await this.ctx.storage.put(`authority:${args[0].id}`, actor);
    await super.onConnect(...args);
  }

  override async onClose(...args: Parameters<AIChatAgent<Env>["onClose"]>) {
    try {
      await super.onClose(...args);
    } finally {
      await this.ctx.storage.delete(`authority:${args[0].id}`);
    }
  }

  async authorizedSocket(socket: WebSocket, message: string | ArrayBuffer) {
    const connection = [...this.getConnections()].find((connection) => connection === socket);
    const actor = connection && (await this.ctx.storage.get<Actor>(`authority:${connection.id}`));
    if (!actor) {
      socket.close(1008, "Reconnect to authenticate");
      return;
    }
    try {
      return await this.withActor(actor, async () => {
        await this.authorizeContent();
        return this.lifecycle.webSocketMessage(socket, message);
      });
    } catch (error) {
      socket.close(1008, "Source access unavailable; reconnect or start a new chat");
      throw error;
    }
  }

  private rawApi() {
    return apiClient(
      app.fetch as never,
      this.env,
      (work) => this.ctx.waitUntil(work),
      () => this.token(),
    );
  }

  async authorizeContent() {
    this.#assertAdmission();
    const actor = this.#actors.getStore();
    if (!actor || !(await isActorCredentialLive(this.env.DB, actor)))
      throw new AssistantContentUnavailable();
    // Close stale viewers before SDK broadcasts or resumable stream publication.
    for (const connection of this.getConnections()) {
      const viewer = await this.ctx.storage.get<Actor>(`authority:${connection.id}`);
      if (!viewer || !(await isActorCredentialLive(this.env.DB, viewer)))
        connection.close(1008, "Reconnect to authenticate");
    }
    await this.token();
    const receipts = await this.ctx.storage.get<ContentReceipt[]>("content-receipts-v4");
    if (!receipts) {
      // Legacy content is retained verbatim, but its source rights are unprovable.
      if (this.messages.some((message) => message.role === "assistant"))
        throw new AssistantContentUnavailable();
      await this.ctx.storage.put("content-receipts-v4", []);
      return;
    }
    await authorizeReceipts(this.rawApi(), receipts);
  }

  private contentApi(): CallApi {
    const api = this.rawApi();
    return async (method, path, body) => {
      await this.authorizeContent();
      const actor = this.#actors.getStore()!;
      if (method !== "GET" && !(await isActorCredentialLive(this.env.DB, actor, "write")))
        throw new AssistantContentUnavailable();
      const probe = contentProbe(method, path);
      // Establish source identity before a mutation can commit.
      const before = probe && (await contentReceipt(api, probe));
      const result = await api(method, path, body);
      if (result.ok && before) {
        const observed =
          method === "GET" && before.kind === "response"
            ? await contentReceipt(api, probe!, result)
            : before;
        const after = await contentReceipt(api, probe!);
        if (
          (observed.kind !== "response" || method === "GET") &&
          observed.identity !== after.identity
        )
          throw new AssistantContentUnavailable();
        const retained = method === "GET" ? observed : after;
        await this.ctx.storage.transaction(async (storage) => {
          const receipts = (await storage.get<ContentReceipt[]>("content-receipts-v4")) ?? [];
          // Never replace the authority for older retained content at this URL.
          // A later read or write cannot erase an earlier source obligation.
          if (
            !receipts.some(
              (receipt) =>
                receipt.path === retained.path &&
                receipt.permissionPath === retained.permissionPath &&
                receipt.kind === retained.kind &&
                receipt.identity === retained.identity,
            )
          )
            receipts.push(retained);
          await storage.put("content-receipts-v4", receipts);
        });
      }
      return result;
    };
  }

  constructor(ctx: DurableObjectState, env: Env, assertAdmission: () => void) {
    super(ctx, env);
    this.#assertAdmission = assertAdmission;
    const trackAlarmWork = this.lifecycle.trackAlarmWork.bind(this.lifecycle);
    const tracked = new WeakMap<Promise<unknown>, Promise<unknown>>();
    this.lifecycle.trackAlarmWork = (work) => {
      this.#assertAdmission();
      this.ctx.waitUntil(
        work.then(
          () => {},
          () => {},
        ),
      );
      let handedOff = tracked.get(work);
      if (!handedOff) {
        // JobDriver attaches an async settlement callback with work.then() and
        // discards the returned promise. Capture that exact finalizer too, not
        // merely the original model turn (which settles before bookkeeping).
        handedOff = new Proxy(work, {
          get: (target, key) => {
            if (key === "then")
              return (
                fulfilled?: (value: unknown) => unknown,
                rejected?: (error: unknown) => unknown,
              ) => {
                const finalizer = target.then(fulfilled, rejected);
                this.ctx.waitUntil(finalizer);
                return finalizer;
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        tracked.set(work, handedOff);
      }
      return trackAlarmWork(handedOff);
    };
  }

  /** Whose model calls these are (CORE-207 metering): the person, or their agent asking (CORE-222). */
  #aiWork(): AiWork {
    return {
      feature: "assistant",
      personId: this.owner.userId,
      actor: this.owner.userId,
      agent: this.cli?.agent ?? null,
    };
  }

  /** "<userId>:<chatId>", fixed by api/assistant.ts. */
  get owner() {
    const [userId, chatId] = this.name.split(":");
    if (!userId || !chatId) throw new Error(`Unexpected assistant instance name ${this.name}`);
    return { userId, chatId };
  }

  private async token(): Promise<string> {
    this.#assertAdmission();
    if (!this.credential)
      this.credential = (await this.ctx.storage.get<AssistantCredential>("credential")) ?? null;
    const next = await credential(this.env.DB, this.owner.userId, this.credential);
    if (next !== this.credential) {
      this.credential = next;
      await this.ctx.storage.put("credential", next);
    }
    return next.token;
  }

  private async plan(
    input: Parameters<typeof clefState>[0],
  ): Promise<{ plan: TurnPlan; routedMs: number | null }> {
    const started = Date.now();
    this.#assertAdmission();
    const deadline = Promise.withResolvers<null>();
    const timer = setTimeout(() => deadline.resolve(null), PLAN_DEADLINE_MS);
    try {
      const planning = aiWork(this.#aiWork(), () =>
        decide(this.env, clefState(input), questions(), { flash: true }),
      );
      // A deadline selects the fallback; it does not cancel the provider call.
      // Its late metering/publication remains inside this invocation's ticket.
      this.ctx.waitUntil(
        planning.then(
          () => {},
          () => {},
        ),
      );
      const answers = await Promise.race([planning, deadline.promise]);
      if (!answers)
        console.warn(`assistant: clef took over ${PLAN_DEADLINE_MS}ms; using a general turn`);
      return { plan: planFrom(answers), routedMs: answers ? Date.now() - started : null };
    } catch (error) {
      console.warn("assistant: clef planning failed; using a general turn", error);
      return { plan: planFrom(null), routedMs: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A few words on what the turn is doing now, or null if the small model can't say in time. */
  private async progress(request: string, step: ProgressStep): Promise<string | null> {
    this.#assertAdmission();
    await this.authorizeContent();
    try {
      const { text: reply, usage } = await generateText({
        model: createWorkersAI({ binding: this.env.AI })(
          ASSISTANT_MODELS.status,
          await aiGatewayOptions(this.env, "assistant-status", this.#aiWork()),
        ),
        instructions: PROGRESS_INSTRUCTIONS,
        prompt: progressPrompt(request, step),
        maxOutputTokens: 16,
        abortSignal: AbortSignal.timeout(STATUS_DEADLINE_MS),
      });
      await recordAiCall(this.env, ASSISTANT_MODELS.status, usageTokens(usage), {
        work: this.#aiWork(),
      });
      await this.authorizeContent();
      return cleanStatus(reply);
    } catch (error) {
      console.warn("assistant: no status line for this step", error);
      return null;
    }
  }

  /** The directory row for this chat: created on its first turn, touched after each. */
  private async touch(source: "web" | "cli") {
    const { userId, chatId } = this.owner;
    await db(this.env.DB)
      .insertInto("assistant_chats")
      .values({ id: chatId, user_id: userId, source, updated_at: nowIso() })
      .onConflict((oc) => oc.column("id").doUpdateSet({ updated_at: nowIso() }))
      .execute();
  }

  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    this.#assertAdmission();
    await this.authorizeContent();
    const cli = this.cli;
    const web = !cli;
    const body = options?.body ?? {};
    const page = web ? ((body.page as PageContext | undefined) ?? null) : null;
    const currentRepo = cli?.repo ?? page?.repo ?? null;
    const lastUser = [...this.messages].reverse().find((m) => m.role === "user");
    const lastReply = [...this.messages].reverse().find((m) => m.role === "assistant");
    const receipt = options?.continuation ? skillReceipt(lastReply) : null;
    const repo = receipt?.source === "repository" ? (receipt.repo ?? null) : currentRepo;
    this.#turnAt = Date.now();
    await this.touch(web ? "web" : "cli");

    const history = this.messages.slice(-60);
    const onError = (error: unknown) => {
      const message =
        error instanceof AssistantContentUnavailable
          ? error.message
          : "The assistant ran into a problem. Try again in a moment.";
      console.error(
        "assistant turn failed",
        error instanceof Error ? error.message : String(error),
      );
      if (cli) this.ctx.waitUntil(cli.emit({ type: "error", message }));
      return message;
    };
    const stream = createUIMessageStream({
      originalMessages: history,
      execute: async ({ writer }) => {
        // Establish the response identity before durable data parts reach the client.
        // The outer stream assigns a new ID, or reuses the continued assistant ID.
        writer.write({ type: "start" });
        const status = (value: string) => {
          writer.write({ type: "data-status", data: { text: value }, transient: true });
          if (cli) this.ctx.waitUntil(cli.emit({ type: "status", text: value }));
        };
        status("Thinking");
        const api = this.contentApi();
        const registry = await buildSkillRegistry(this.env.DB, this.owner.userId, api, repo);
        const invocation = resolveSkillInvocation(
          registry,
          text(lastUser),
          Boolean(options?.continuation),
          receipt,
        );
        if (invocation && !options?.continuation && lastUser) {
          const { id, name, description, source, repo: skillRepo } = invocation;
          writer.write({
            type: "data-skill",
            id: `skill-${lastUser.id}`,
            data: { id, name, description, source, ...(skillRepo ? { repo: skillRepo } : {}) },
          });
        }
        await this.authorizeContent();
        const [{ plan, routedMs }, person] = await Promise.all([
          this.plan({
            message: invocation
              ? `${text(lastUser).replace(/^\/\S+\s*/, "")}\n\nSkill /${invocation.name}: ${invocation.description}\n${invocation.body}`
              : text(lastUser),
            page: page ? { path: page.path, title: page.title } : null,
            previous: options?.continuation ? undefined : text(lastReply),
          }),
          db(this.env.DB)
            .selectFrom("accounts")
            .select("display_name")
            .where("id", "=", this.owner.userId)
            .executeTakeFirst(),
        ]);
        await this.authorizeContent();
        status(plan.status);
        const model = plan.tier === "deep" ? ASSISTANT_MODELS.deep : ASSISTANT_MODELS.fast;
        if (cli)
          this.ctx.waitUntil(
            cli.emit({
              type: "plan",
              intent: plan.intent,
              model,
              groups: plan.groups,
              codemode: plan.codemode,
              routedMs,
            }),
          );

        const tools = buildTools({
          api,
          writes: web || cli.write,
          approve: web,
          navigate: web,
        });
        const groups = plan.groups;
        const selected: ToolSet = Object.assign(
          {},
          tools.general,
          ...groups.map((g) => tools.groups[g]),
        );
        // Writes ride along whenever the turn could lead to one; approval guards them on the web.
        const writing = plan.intent === "act" || plan.intent === "plan" || options?.continuation;
        const active: ToolSet = {
          ...selected,
          ...(writing || groups.some((g) => g === "tracker" || g === "ci" || g === "repository")
            ? tools.writes
            : {}),
          ...tools.navigate,
        };
        // Code Mode: one script instead of a dozen round trips, for reads only.
        const loader = (this.env as { LOADER?: WorkerLoader }).LOADER;
        if (plan.codemode && loader)
          active.codemode = createCodeTool({
            tools: tools.reads,
            executor: new DynamicWorkerExecutor({ loader, globalOutbound: null, timeout: 30_000 }),
          });

        const names = preloaded(groups, web && plan.intent === "navigate");
        if (invocation && !names.includes(invocation.name)) names.push(invocation.name);
        const loaded = names.map((name) => registry.get(name)).filter((skill) => skill !== null);
        const skills = [
          registry.catalog(names),
          ...loaded.map((skill) => `## Skill: ${skill.name}\n\n${skill.body}`),
        ].join("\n\n");

        // Between steps nothing streams while the model reads what its tools
        // returned. The chat says so at once, then in the small model's words;
        // a status that arrives after the step's first output is dropped.
        let between: number | null = null;
        const show = (value: string) => {
          try {
            writer.write({ type: "data-status", data: { text: value }, transient: true });
          } catch {
            // The turn ended before the status was ready.
          }
        };
        const nextStep = web
          ? ({ stepNumber, steps }: { stepNumber: number; steps: readonly ProgressStep[] }) => {
              const previous =
                stepNumber === 0
                  ? options?.continuation
                    ? stepFromMessage(lastReply)
                    : null
                  : steps.at(-1);
              if (!previous) return;
              between = stepNumber;
              if (stepNumber > 0) show(WORKING);
              this.ctx.waitUntil(
                this.progress(text(lastUser), previous).then((line) => {
                  if (line && between === stepNumber) show(line);
                }),
              );
            }
          : undefined;
        const output = (type: string) => {
          if (type === "text-delta" || type === "tool-input-start" || type === "tool-call")
            between = null;
        };

        const workersai = createWorkersAI({ binding: this.env.AI });
        await this.authorizeContent();
        const result = streamText({
          model: wrapLanguageModel({
            model: workersai(model, {
              ...(await aiGatewayOptions(this.env, "assistant", this.#aiWork())),
              reasoning_effort: plan.reasoning,
              sessionAffinity: this.name,
            }),
            middleware: assistantCapacity,
          }),
          instructions: instructions({
            person: person?.display_name ?? "the person",
            page,
            repo,
            plan,
            skills,
            web,
          }),
          messages: await convertToModelMessages(history),
          tools: { ...active, ...registry.tools() },
          stopWhen: stepCountIs(plan.tier === "deep" ? 30 : 16),
          abortSignal: options?.abortSignal,
          onStepStart: async (step) => {
            await this.authorizeContent();
            nextStep?.(step);
          },
          onChunk: async ({ chunk }) => {
            await this.authorizeContent();
            output(chunk.type);
            if (!cli) return;
            if (chunk.type === "text-delta") await cli.emit({ type: "text", delta: chunk.text });
            else if (chunk.type === "tool-call")
              await cli.emit({
                type: "tool",
                name: chunk.toolName,
                label: toolLabel(chunk.toolName, (chunk.input ?? {}) as Record<string, unknown>),
              });
          },
          // Metering (CORE-207): the turn's model steps and tokens.
          onFinish: (async (event: {
            steps?: unknown[];
            totalUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
          }) => {
            this.#assertAdmission();
            await this.authorizeContent();
            between = null;
            await recordAiCall(this.env, model, usageTokens(event.totalUsage), {
              calls: event.steps?.length || 1,
              work: this.#aiWork(),
            });
            return (onFinish as unknown as (event: unknown) => unknown)(event);
          }) as never,
        });
        // Client cancellation does not prove the provider/tool callbacks ended.
        // Hold admission through the model stream and its awaited finish hooks.
        this.ctx.waitUntil(Promise.resolve(result.consumeStream()));
        writer.merge(result.toUIMessageStream({ sendStart: false, sendReasoning: false, onError }));
      },
      onError,
    });
    return createUIMessageStreamResponse({ stream });
  }

  protected async onChatResponse() {
    await this.authorizeContent();
    this.#assertAdmission();
    // Name the chat after its first exchange.
    const { userId, chatId } = this.owner;
    const row = await db(this.env.DB)
      .selectFrom("assistant_chats")
      .select("title")
      .where("id", "=", chatId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!row || row.title) return;
    const first = text(this.messages.find((m) => m.role === "user"));
    if (!first) return;
    try {
      const { text: title, usage } = await generateText({
        model: createWorkersAI({ binding: this.env.AI })(
          ASSISTANT_MODELS.title,
          await aiGatewayOptions(this.env, "assistant-title", this.#aiWork()),
        ),
        instructions:
          "Name this conversation in 2 to 6 words, sentence case, no quotes or trailing punctuation.",
        prompt: first.slice(0, 1500),
        maxOutputTokens: 20,
      });
      await recordAiCall(this.env, ASSISTANT_MODELS.title, usageTokens(usage), {
        work: this.#aiWork(),
      });
      await this.authorizeContent();
      const clean = sentenceCase(title.replace(/["“”.]/g, "").trim()).slice(0, 80);
      await db(this.env.DB)
        .updateTable("assistant_chats")
        .set({ title: clean || first.slice(0, 60) })
        .where("id", "=", chatId)
        .execute();
    } catch {
      await this.authorizeContent();
      await db(this.env.DB)
        .updateTable("assistant_chats")
        .set({ title: first.slice(0, 60) })
        .where("id", "=", chatId)
        .execute();
    }
  }

  /**
   * One turn from `gm ask`, streamed back as newline-delimited AskEvents. It
   * lands in the same transcript, so the chat can be continued on the web.
   */
  async ask(
    question: string,
    options: { actor: Actor; write: boolean; repo?: string; url: string },
  ) {
    await this.withActor(options.actor, () => this.authorizeContent());
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let answer = "";
    const emit = async (event: AskEvent) => {
      if (event.type === "text") answer += event.delta;
      await writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {});
    };
    this.ctx.waitUntil(
      this.withActor(options.actor, async () => {
        await emit({ type: "chat", chatId: this.owner.chatId, url: options.url });
        this.cli = {
          write: options.write,
          repo: options.repo,
          // The agent that asked, from the authenticated actor (CORE-222).
          agent: options.actor.agent?.id,
          emit,
        };
        try {
          const result = await this.saveMessages((messages) => [
            ...messages,
            { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: question }] },
          ]);
          await this.authorizeContent();
          if (result.status === "error")
            await emit({ type: "error", message: result.error ?? "The turn failed." });
          else await emit({ type: "done", answer });
        } catch (error) {
          await emit({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          this.cli = null;
          await writer.close().catch(() => {});
        }
      }).catch(async (error) => {
        await emit({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        await writer.close().catch(() => {});
      }),
    );
    return readable;
  }

  // The purge contract (worker/durable/contract.ts, CORE-197), on the Agents
  // SDK's destroy(): it stops the agent's own alarms and connections, deletes
  // all storage and resets the instance on the next tick.
  async purge(reason: string): Promise<PurgeReport> {
    await this.destroy();
    return confirmPurged(this.ctx.storage, reason);
  }

  /**
   * Purge unless the chat is being written to (retention, CORE-204): a turn
   * streaming, a `gm ask` turn, or one started in the last TURN_GRACE_MS (it
   * may not stream yet). Null when it's busy, and nothing changes.
   */
  async purgeIfIdle(reason: string): Promise<PurgeReport | null> {
    if (this.cli || this._activeStreamId !== null || Date.now() - this.#turnAt < TURN_GRACE_MS)
      return null;
    return this.purge(reason);
  }

  /** Purge from the agent's own scheduler (its alarm), after the turn in progress. */
  async retire(reason: string, name: string, delayMs = RETIRE_DELAY_MS): Promise<void> {
    await this.schedule(Math.max(1, Math.ceil(delayMs / 1_000)), "retireNow", { reason, name });
  }

  /** The scheduled half of retire(). */
  async retireNow({ reason, name }: { reason: string; name: string }): Promise<void> {
    // Recorded first: destroy() resets the instance right after it returns.
    await recordPurge(this.env, "Assistant", name, {
      reason,
      purgedAt: nowIso(),
      bytes: 0,
      tables: [],
      keys: 0,
      alarm: null,
    }).catch((error) => console.error("Durable: recording a retirement failed", error));
    await this.destroy();
  }

  storageReport() {
    return storageReport(this.ctx.storage);
  }

  /** The transcript as plain text turns, for `gm assistant show`. */
  async transcript() {
    await this.authorizeContent();
    return this.messages.map((m) => ({
      role: m.role,
      text: [
        ...m.parts.flatMap((part) => {
          if (part.type !== "data-skill") return [];
          const receipt = skillReceipt({ ...m, parts: [part] });
          return receipt
            ? [
                `Used /${receipt.name} (${receipt.source}${receipt.repo ? `: ${receipt.repo}` : ""})`,
              ]
            : [];
        }),
        text(m),
      ]
        .filter(Boolean)
        .join("\n\n"),
      tools: m.parts
        .filter((p) => p.type.startsWith("tool-"))
        .map((p) => {
          const part = p as {
            type: string;
            input?: unknown;
            output?: { error?: unknown };
            state?: string;
            errorText?: string;
          };
          const name = part.type.slice(5);
          const failure =
            part.state === "output-error"
              ? part.errorText
              : typeof part.output?.error === "string"
                ? part.output.error
                : null;
          return `${toolLabel(name, (part.input ?? {}) as Record<string, unknown>)}${
            part.state === "output-denied"
              ? " (declined)"
              : failure
                ? ` (failed: ${failure.slice(0, 300)})`
                : ""
          }`;
        }),
    }));
  }
};
