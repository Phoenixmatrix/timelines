/**
 * Whether `error` is workerd's answer to an RPC call of `method` on a Durable
 * Object whose running class has no such method.
 *
 * Cloudflare deploys a Worker's code to its Durable Objects separately and
 * eventually ("Code updates" in the Durable Objects docs: Worker-to-Durable
 * Object RPC must stay forward and backward compatible across an update). For
 * minutes after a deploy, a new isolate can call an object still running the
 * previous release (and the reverse after a rollback). A caller of a method
 * added in this release catches this error, and only this one, and falls back
 * to the previous release's methods. Keep that fallback until a later release
 * has shipped the method everywhere (expand, then contract).
 */
export function isMissingRpcMethod(error: unknown, method: string): boolean {
  return (
    error instanceof Error &&
    (error instanceof TypeError || error.name === "TypeError") &&
    error.message.includes(`The RPC receiver does not implement the method "${method}"`)
  );
}
