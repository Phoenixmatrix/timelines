import { TrashIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { FORMAT_IDS, type FormatId } from "@gitmatrix/formats/info";
import type {
  FeedSummary,
  FeedVisibility,
  SpacePackages as SpacePackagesData,
} from "../../../shared/packages.ts";
import { Page } from "../../components/AppShell.tsx";
import {
  ConfirmDialog,
  FormError,
  SelectField,
  TextField,
  useToast,
} from "../../components/ui.tsx";
import { api, attempt, field, load } from "../../lib/api.ts";
import { FORMATS, formatLabel, packagesPath, plural } from "../../lib/packages.ts";

export async function feedsLoader({ request, params }: LoaderFunctionArgs) {
  return load<SpacePackagesData>(`/packages/${params.space}`, request);
}

const optionalNumber = (value: string) => (value.trim() ? Number(value) : undefined);

export async function feedsAction({ request, params }: ActionFunctionArgs) {
  const form = await request.formData();
  const space = params.space ?? "";
  const intent = field(form, "intent");
  const feed = `/packages/${space}/feeds/${field(form, "format")}/${field(form, "key")}`;
  return attempt(async () => {
    if (intent === "create") {
      const kind = field(form, "kind") as "remote" | "virtual";
      await api(`/packages/${space}/feeds`, {
        method: "POST",
        json: {
          format: field(form, "format"),
          kind,
          name: field(form, "name"),
          visibility: field(form, "visibility") || "private",
          ...(kind === "remote"
            ? {
                upstream: field(form, "upstream") || undefined,
                upstreamUsername: field(form, "upstreamUsername") || undefined,
                upstreamPassword: field(form, "upstreamPassword") || undefined,
              }
            : {
                members: field(form, "members")
                  .split(/[\s,]+/)
                  .filter(Boolean),
              }),
        },
      });
      return { ok: `Created ${space}.${field(form, "name")}` };
    }
    if (intent === "delete") {
      await api(feed, { method: "DELETE" });
      return { ok: `Deleted ${field(form, "key")}` };
    }
    await api(feed, {
      method: "PATCH",
      json: {
        visibility: field(form, "visibility") as FeedVisibility,
        retention: {
          keepLatest: optionalNumber(field(form, "keepLatest")),
          maxAgeDays: optionalNumber(field(form, "maxAgeDays")),
          ...(field(form, "format") === "oci"
            ? { deleteUntagged: form.get("deleteUntagged") === "on" }
            : {}),
        },
        ...(form.has("upstream") ? { upstream: field(form, "upstream") } : {}),
        ...(form.has("members")
          ? {
              members: field(form, "members")
                .split(/[\s,]+/)
                .filter(Boolean),
            }
          : {}),
      },
    });
    return { ok: `Saved ${field(form, "key")}` };
  });
}

const VISIBILITY = [
  { value: "private", label: "Private: the space's people and CI" },
  { value: "internal", label: "Internal: anyone signed in" },
  { value: "public", label: "Public: anyone" },
];

function FeedRow({ feed, space }: { feed: FeedSummary; space: string }) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const busy = navigation.state !== "idle";
  const describe =
    feed.kind === "local"
      ? `${space}'s own ${formatLabel(feed.format)} registry · ${plural(feed.packages, "package")}`
      : feed.kind === "remote"
        ? `Proxy and cache of ${feed.upstream}`
        : `Resolves from ${feed.members.join(", ") || "nothing yet"}, in that order`;
  return (
    <li className="mk-card">
      <Form method="post" className="flex flex-col gap-4">
        <input type="hidden" name="key" value={feed.key} />
        <input type="hidden" name="format" value={feed.format} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0 flex flex-wrap items-center gap-2 text-title">
              <span className="mk-mono">{feed.key}</span>
              <span className="mk-chip mk-chip--tag">{formatLabel(feed.format)}</span>
            </h3>
            <p className="m-0 mt-0.5 text-body-sm text-ink-muted">{describe}</p>
          </div>
          {feed.kind !== "local" && (
            <ConfirmDialog
              trigger={
                <button type="button" className="mk-btn mk-btn--sm mk-btn--danger-ghost">
                  <TrashIcon weight="bold" aria-hidden />
                  Delete
                </button>
              }
              title={`Delete ${feed.key}?`}
              description={
                feed.kind === "remote"
                  ? "Its cache goes with it. Clients pointed at it stop resolving."
                  : "Clients pointed at it stop resolving. Its members keep their packages."
              }
              confirmLabel="Delete feed"
              onConfirm={() =>
                submit({ intent: "delete", key: feed.key, format: feed.format }, { method: "post" })
              }
            />
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="mk-field">
            <span className="mk-label">Who can install</span>
            <SelectField
              name="visibility"
              defaultValue={feed.visibility}
              options={VISIBILITY}
              ariaLabel={`Who can install from ${feed.key}`}
            />
          </div>
          {feed.kind === "local" && (
            <>
              <TextField
                label="Keep the newest"
                name="keepLatest"
                type="number"
                min={1}
                inputMode="numeric"
                defaultValue={feed.retention.keepLatest ?? ""}
                placeholder="Every version"
                hint="Versions per package. Tagged ones always stay."
              />
              <TextField
                label="Remove after (days)"
                name="maxAgeDays"
                type="number"
                min={1}
                inputMode="numeric"
                defaultValue={feed.retention.maxAgeDays ?? ""}
                placeholder="Never"
                hint="Checked hourly."
              />
            </>
          )}
          {feed.kind === "remote" && (
            <TextField
              className="md:col-span-2"
              label="Upstream"
              name="upstream"
              type="url"
              defaultValue={feed.upstream ?? ""}
            />
          )}
          {feed.kind === "virtual" && (
            <TextField
              className="md:col-span-2"
              label="Members, in order"
              name="members"
              defaultValue={feed.members.join(", ")}
              hint="Feed keys of the same format, separated by commas."
            />
          )}
        </div>
        {feed.kind === "local" && feed.format === "oci" && (
          <label className="flex items-center gap-2 text-body-sm">
            <input
              type="checkbox"
              name="deleteUntagged"
              className="m-0 size-4 cursor-pointer accent-signal"
              defaultChecked={feed.retention.deleteUntagged ?? false}
            />
            Delete images when their last tag goes
          </label>
        )}
        <div>
          <button
            type="submit"
            name="intent"
            value="update"
            className="mk-btn mk-btn--sm"
            disabled={busy}
          >
            Save {feed.key}
          </button>
        </div>
      </Form>
    </li>
  );
}

function NewFeed({ space }: { space: string }) {
  const [kind, setKind] = useState<"remote" | "virtual">("remote");
  const [format, setFormat] = useState<FormatId>("npm");
  const navigation = useNavigation();
  const formats = FORMAT_IDS.filter((f) => FORMATS[f].kinds.includes(kind));
  return (
    <section className="mk-card">
      <h2 className="mk-card-title">Add a proxy or virtual feed</h2>
      <p className="mk-card-desc max-w-[48ch]">
        A proxy caches a public registry so builds never wait on it. A virtual feed puts several
        behind one URL: yours first, then the proxy.
      </p>
      <Form method="post" className="mk-card-body">
        <input type="hidden" name="intent" value="create" />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="format" value={format} />
        <div className="mk-segmented self-start" role="radiogroup" aria-label="Kind">
          {(["remote", "virtual"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className="mk-segment"
              onClick={() => setKind(k)}
            >
              {k === "remote" ? "Proxy" : "Virtual"}
            </button>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="mk-field">
            <span className="mk-label">Format</span>
            <SelectField
              value={formats.includes(format) ? format : formats[0]}
              onChange={(v) => setFormat(v as FormatId)}
              options={formats.map((f) => ({ value: f, label: FORMATS[f].label }))}
              ariaLabel="Format"
            />
          </div>
          <TextField
            label="Name"
            name="name"
            required
            pattern="[a-z0-9][a-z0-9_\-]{0,40}"
            placeholder={kind === "remote" ? "npmjs" : "all"}
            hint={`Clients use ${space}.<name>.`}
          />
          {kind === "remote" ? (
            <>
              <TextField
                className="md:col-span-2"
                label="Upstream"
                name="upstream"
                type="url"
                placeholder={FORMATS[format].defaultUpstream ?? "https://"}
                hint="Leave empty for the format's public registry."
              />
              <TextField label="Upstream username" name="upstreamUsername" autoComplete="off" />
              <TextField
                label="Upstream password or token"
                name="upstreamPassword"
                type="password"
                autoComplete="new-password"
                hint="Sealed at rest and never shown again."
              />
            </>
          ) : (
            <TextField
              className="md:col-span-2"
              label="Members, in order"
              name="members"
              placeholder={`${space}, ${space}.npmjs`}
              hint="Feed keys of the same format. The first that has a package wins."
            />
          )}
        </div>
        <div>
          <button
            type="submit"
            className="mk-btn mk-btn--primary"
            disabled={navigation.state !== "idle"}
          >
            Add {kind === "remote" ? "proxy" : "virtual feed"}
          </button>
        </div>
      </Form>
    </section>
  );
}

export function Feeds() {
  const data = useLoaderData<typeof feedsLoader>();
  const result = useActionData<typeof feedsAction>();
  const space = data.space.slug;
  const toast = useToast();
  useEffect(() => {
    if (result && "ok" in result) toast.add({ title: result.ok });
  }, [result, toast]);
  return (
    <Page>
      <nav aria-label="Breadcrumb" className="text-body-sm text-ink-muted">
        <Link to={`/${space}`} className="text-ink-muted no-underline hover:text-ink">
          {space}
        </Link>
        <span className="px-1.5 text-ink-faint">/</span>
        <Link to={packagesPath(space)} className="text-ink-muted no-underline hover:text-ink">
          Packages
        </Link>
      </nav>
      <h1 className="m-0 mt-2 text-headline">Feeds and proxies</h1>
      <p className="m-0 mt-1 max-w-[48ch] text-ink-muted">
        Every format gets a registry for {space} the first time something is published to it. Set
        who can install from each, how long versions stay, and add proxies of public registries.
      </p>
      {result && "error" in result && (
        <div className="mt-4">
          <FormError message={result.error} />
        </div>
      )}
      {data.access !== "admin" ? (
        <div className="mk-empty mt-6">Only {space}'s admins manage its feeds.</div>
      ) : (
        <>
          <h2 className="mt-8 mb-3 text-title">Feeds</h2>
          {data.feeds.length === 0 ? (
            <div className="mk-empty">None yet. Publish something, or add a proxy below.</div>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-6 p-0">
              {data.feeds.map((feed) => (
                <FeedRow key={feed.id} feed={feed} space={space} />
              ))}
            </ul>
          )}
          <div className="mt-8">
            <NewFeed space={space} />
          </div>
        </>
      )}
    </Page>
  );
}
