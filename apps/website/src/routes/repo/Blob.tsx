import { useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import { repoData, routeData } from "../../lib/repoData.ts";
import { bytes } from "../../lib/format.ts";
import { blobUrl } from "../../lib/refs.ts";
import { RefBar } from "./RefPicker.tsx";
import { useRepo } from "./RepoLayout.tsx";

export async function blobLoader({ params }: LoaderFunctionArgs) {
  return routeData(repoData.blob(params.owner ?? "", params.repo ?? "", params["*"] ?? ""));
}

export function Blob() {
  const blob = useLoaderData<typeof blobLoader>();
  const repo = useRepo();
  const navigate = useNavigate();
  const lines = blob.text?.replace(/\n$/, "").split("\n") ?? [];
  const fileName = blob.path.split("/").pop();

  return (
    <div className="flex flex-col gap-4">
      <RefBar
        repo={repo}
        refName={blob.ref}
        path={blob.path}
        view="blob"
        onSwitch={(ref) => navigate(blobUrl(repo.owner.slug, repo.name, ref, blob.path))}
      />
      <section className="overflow-hidden rounded-pane bg-pane">
        <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3 text-body-sm">
          <span className="font-semibold">{fileName}</span>
          <span className="text-ink-faint">
            {blob.binary ? bytes(blob.size) : `${lines.length} lines · ${bytes(blob.size)}`}
          </span>
        </div>
        {blob.binary ? (
          <div className="mk-empty m-4">
            Binary file, not shown.
            <br />
            <span className="text-body-sm text-ink-faint">Clone the repository to open it.</span>
          </div>
        ) : (
          <div className="overflow-x-auto bg-sunken py-3">
            <table className="w-full border-collapse font-mono text-body-sm leading-5">
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index}>
                    <td className="w-px pr-4 pl-4 text-right align-top text-ink-faint tabular-nums select-none">
                      {index + 1}
                    </td>
                    <td className="pr-4 whitespace-pre">{line || " "}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {blob.truncated && (
              <p className="mx-4 mt-3 mb-0 text-body-sm text-ink-faint">
                Showing the first 1 MB. Clone the repository for the rest.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
