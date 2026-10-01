import { data } from "react-router";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error ?? `Request failed (${response.status}).`,
      typeof body?.code === "string" ? body.code : undefined,
    );
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
