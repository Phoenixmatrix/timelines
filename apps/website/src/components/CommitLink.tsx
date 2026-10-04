// A link that opens the commit side panel (CORE-22): over the current page
// when it belongs to the commit's repository, else on the repository's page.

import { Link, type LinkProps } from "react-router";
import { useCommitHref } from "../lib/commitPanel.ts";

export function CommitLink({
  owner,
  name,
  sha,
  ...props
}: Omit<LinkProps, "to" | "state"> & { owner: string; name: string; sha: string }) {
  const href = useCommitHref()(owner, name, sha);
  return <Link {...props} to={href.to} state={href.state} preventScrollReset />;
}
