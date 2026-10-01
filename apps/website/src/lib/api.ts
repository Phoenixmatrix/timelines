import { data } from "react-router";
import type { RepoDetail } from "../../shared/api.ts";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fetch JSON from the Worker's API; non-2xx responses throw an ApiError. */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...rest,
    headers,
    body: json === undefined ? rest.body : JSON.stringify(json),
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new ApiError(response.status, body?.error ?? `Request failed (${response.status}).`);
  }
  return body as T;
}

/** A text field from submitted form data ("" when missing or a file). */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** For loaders: rethrow API failures as route errors the error boundary can show. */
export async function load<T>(path: string, request: Request): Promise<T> {
  try {
    return await api<T>(path, { signal: request.signal });
  } catch (error) {
    if (error instanceof ApiError) throw data({ message: error.message }, { status: error.status });
    throw error;
  }
}

/** For actions: return the message so the form can show it inline. */
export async function attempt<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
}

// The repo layout and its child routes load in parallel and both need the
// repo's refs; share one request between them.
const repoRequests = new Map<string, { at: number; promise: Promise<RepoDetail> }>();

export function loadRepo(owner: string, name: string, request: Request): Promise<RepoDetail> {
  const key = `${owner}/${name}`.toLowerCase();
  const cached = repoRequests.get(key);
  if (cached && Date.now() - cached.at < 2000) return cached.promise;
  const promise = load<RepoDetail>(`/repos/${owner}/${name}`, request);
  repoRequests.set(key, { at: Date.now(), promise });
  promise.catch(() => repoRequests.delete(key));
  return promise;
}

export function forgetRepo(owner: string, name: string) {
  repoRequests.delete(`${owner}/${name}`.toLowerCase());
}
