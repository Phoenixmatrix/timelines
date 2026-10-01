/**
 * Pulls the secret out of whatever shape each ecosystem's client sends:
 * docker, pip, twine, maven, apt, dnf, helm and git send Basic, npm sends
 * Bearer, and cargo sends the raw token with no scheme.
 *
 * Accepted, in order:
 *   x-api-key / X-JFrog-Art-Api: <token>
 *   Authorization: Bearer <token>
 *   Authorization: Basic base64(user:secret)   (username ignored; `token`,
 *     `__token__` or anything else works. An empty secret with a token-shaped
 *     username uses the username, which is how some tools put a token in URLs.)
 *   Authorization: token <token>
 *   Authorization: <token>                      (cargo)
 */
export interface ExtractedCredential {
  token: string;
  scheme: "api-key" | "bearer" | "basic" | "token" | "raw";
  username?: string;
}

function looksLikeToken(value: string): boolean {
  return value.startsWith("gmx_") || value.startsWith("gmj_") || value.split(".").length === 3;
}

export function extractCredential(headers: Headers): ExtractedCredential | null {
  const apiKey = headers.get("x-api-key") ?? headers.get("x-jfrog-art-api");
  if (apiKey?.trim()) return { token: apiKey.trim(), scheme: "api-key" };

  const header = headers.get("authorization")?.trim();
  if (!header) return null;

  const space = header.indexOf(" ");
  const scheme = space === -1 ? "" : header.slice(0, space).toLowerCase();
  const value = space === -1 ? header : header.slice(space + 1).trim();

  if (scheme === "bearer") return value ? { token: value, scheme: "bearer" } : null;
  if (scheme === "token") return value ? { token: value, scheme: "token" } : null;
  if (scheme === "basic") {
    let decoded: string;
    try {
      decoded = new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
    const colon = decoded.indexOf(":");
    const username = colon === -1 ? decoded : decoded.slice(0, colon);
    const secret = colon === -1 ? "" : decoded.slice(colon + 1);
    if (secret) return { token: secret, scheme: "basic", username };
    if (username && looksLikeToken(username)) return { token: username, scheme: "basic" };
    return null;
  }
  if (space === -1 && header) return { token: header, scheme: "raw" };
  return null;
}
