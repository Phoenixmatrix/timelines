import { isValidName } from "@gitmatrix/formats/oci";

/** `<repoKey>/<image path>`: the first segment picks the gitmatrix repository. */
export interface OciName {
  full: string;
  repoKey: string;
  image: string;
}

export function splitName(full: string): OciName | null {
  if (!isValidName(full)) return null;
  const slash = full.indexOf("/");
  if (slash === -1) return null;
  return { full, repoKey: full.slice(0, slash), image: full.slice(slash + 1) };
}
