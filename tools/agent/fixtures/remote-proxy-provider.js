import { RpcTarget } from "cloudflare:workers";
import { newWebSocketRpcSession } from "./capnweb.js";

// An isolated RPC provider, not an Artifacts emulator: the transport and capability
// lifetime are real, while small deterministic results keep the test credential-free.
class Repo extends RpcTarget {
  constructor(event, name) {
    super();
    this.event = event;
    this.name = name;
  }
  async info() {
    await this.event("info");
    return { id: "fixture-id", name: this.name };
  }
  async readFile() {
    await this.event("readFile");
    return new Blob(["materialized repo content"], { type: "text/plain" });
  }
  async createToken() {
    await this.event("createToken");
    return { plaintext: "fixture-token" };
  }
  async revokeToken() {
    await this.event("revokeToken");
  }
  async fork() {
    await this.event("fork");
    return { id: "fork-id" };
  }
}
class Namespace extends RpcTarget {
  constructor(event) {
    super();
    this.event = event;
  }
  async get(name) {
    await this.event("get");
    return new Repo(this.event, name);
  }
  async list() {
    await this.event("list");
    return { repos: [], cursor: null };
  }
  async create() {
    await this.event("create");
    return { id: "created-id" };
  }
  async import() {
    await this.event("import");
    return { id: "imported-id" };
  }
  async delete() {
    await this.event("delete");
  }
}
export default {
  async fetch(request, env) {
    const session = new URL(request.url).searchParams.get("session");
    const event = async (method) => {
      const response = await env.CONTROL.fetch("http://control/event", {
        method: "POST",
        body: JSON.stringify({ session, method }),
      });
      const action = await response.json();
      if (action.error) throw new Error(action.error);
    };
    const pair = new WebSocketPair();
    pair[1].accept();
    const root = newWebSocketRpcSession(pair[1], new Namespace(event));
    pair[1].addEventListener("close", () => root[Symbol.dispose]());
    return new Response(null, { status: 101, webSocket: pair[0] });
  },
};
