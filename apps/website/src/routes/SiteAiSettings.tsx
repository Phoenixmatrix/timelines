import { useEffect, useRef, useState } from "react";
import { redirect, useLoaderData } from "react-router";
import type { AiLogBodiesPatch, AiLogComponent, SiteAiSettingsView } from "../../shared/ai.ts";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { FormError, link } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

export async function siteAiSettingsLoader({ request }: { request: Request }) {
  const viewer = await requireViewer(request);
  if (!viewer.isSiteAdmin) throw redirect("/");
  return api<SiteAiSettingsView>("/admin/ai", { signal: request.signal });
}

type Choices = Record<AiLogComponent, boolean>;
const choices = (view: SiteAiSettingsView) =>
  Object.fromEntries(view.logBodies.components.map((e) => [e.component, e.site])) as Choices;

/** Instance AI settings: infrastructure defaults, separate from Space policy. */
export function SiteAiSettings() {
  const initial = useLoaderData<typeof siteAiSettingsLoader>();
  const [saved, setSaved] = useState(initial);
  const [logBodies, setLogBodies] = useState(choices(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const patch: AiLogBodiesPatch = {};
  for (const entry of saved.logBodies.components)
    if (logBodies[entry.component] !== entry.site)
      patch[entry.component] = logBodies[entry.component];
  const dirty = Object.keys(patch).length > 0;
  const environment = saved.logBodies.environmentDefault ? "on" : "off";
  const save = async (body: AiLogBodiesPatch, message: string) => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const persisted = await api<SiteAiSettingsView>("/admin/ai", {
        method: "PATCH",
        json: { logBodies: body },
      });
      if (!active.current) return;
      setSaved(persisted);
      setLogBodies(choices(persisted));
      setNotice(message);
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "Couldn't save settings. Try again.");
    } finally {
      if (active.current) setSaving(false);
    }
  };
  return (
    <SettingsPage>
      <div className="max-w-3xl">
        <h1 className="m-0 text-headline">Instance AI settings</h1>
        <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
          Instance defaults for AI work. A Space’s explicitly authorized administrators can override
          them for that Space in its AI settings.
        </p>
        <form
          className="mk-card mt-8 flex flex-col gap-6"
          aria-busy={saving}
          onSubmit={(event) => {
            event.preventDefault();
            if (saving || !saved.canManage || !dirty) return;
            void save(
              patch,
              "Instance AI settings saved. New model calls use them within a minute.",
            );
          }}
        >
          <fieldset
            disabled={saving || !saved.canManage}
            className="m-0 min-w-0 border-0 p-0"
            data-log-bodies="instance"
          >
            <legend className="mb-2 text-title">
              Keep AI request and response bodies in gateway logs
            </legend>
            <p className="mt-0 mb-2 max-w-[65ch] text-body-sm text-ink-muted">
              AI Gateway records model, time and token metadata when logging is available. Choose
              whether it also stores what was sent and returned, subject to Cloudflare’s log limits.
              Without a site choice, a part follows this environment’s default ({environment}).
            </p>
            <p
              className="mt-0 mb-4 max-w-[65ch] text-body-sm font-semibold text-ink"
              data-log-bodies-note
            >
              {saved.logBodies.note}
            </p>
            <p className="mt-0 mb-4 max-w-[65ch] text-body-sm text-ink-muted">
              <a
                href="https://developers.cloudflare.com/ai-gateway/reference/limits/"
                className={link}
                target="_blank"
                rel="noreferrer"
              >
                Cloudflare log limits
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
            {!saved.canManage && (
              <p className="mt-0 mb-4 text-body-sm font-semibold text-ink">
                Read-only access. Only a signed-in site administrator can change these settings.
              </p>
            )}
            <div className="flex flex-col gap-4">
              {saved.logBodies.components.map((entry) => {
                const helpId = `site-log-bodies-${entry.component}-help`;
                return (
                  <div key={entry.component} data-log-bodies-component={entry.component}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 font-semibold">
                      <input
                        type="checkbox"
                        className="m-0 size-4 shrink-0 cursor-pointer accent-signal"
                        checked={logBodies[entry.component]}
                        aria-describedby={helpId}
                        onChange={(event) => {
                          setLogBodies({ ...logBodies, [entry.component]: event.target.checked });
                          setNotice("");
                          setError("");
                        }}
                      />
                      {entry.label}
                    </label>
                    <p
                      id={helpId}
                      className="mt-0 mb-0 ml-7 max-w-[65ch] text-body-sm text-ink-muted"
                    >
                      {entry.description}{" "}
                      {entry.siteFrom === "environment"
                        ? `Following the environment default (${environment}).`
                        : "Set for the site."}
                    </p>
                  </div>
                );
              })}
            </div>
          </fieldset>
          <div className="flex flex-col items-start gap-3 border-t border-line pt-5">
            <FormError message={error} />
            <p role="status" aria-live="polite" className="m-0 text-body-sm">
              {saving
                ? "Saving Instance AI settings…"
                : notice || (dirty ? "You have unsaved changes." : "")}
            </p>
            {saved.canManage && (
              <div className="mk-form-actions">
                <button
                  type="submit"
                  className="mk-btn mk-btn--primary min-h-11"
                  disabled={saving || !dirty}
                >
                  {saving ? "Saving…" : "Save Instance AI settings"}
                </button>
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost min-h-11"
                  disabled={saving || !dirty}
                  onClick={() => {
                    setLogBodies(choices(saved));
                    setNotice("");
                    setError("");
                  }}
                >
                  Discard changes
                </button>
                {saved.logBodies.components.some((e) => e.siteFrom === "site") && (
                  <button
                    type="button"
                    className="mk-btn mk-btn--ghost min-h-11"
                    disabled={saving}
                    onClick={() =>
                      void save(
                        Object.fromEntries(
                          saved.logBodies.components.map((e) => [e.component, null]),
                        ) as AiLogBodiesPatch,
                        `Instance AI settings reset: every part follows the environment default (${environment}).`,
                      )
                    }
                  >
                    Use the environment default
                  </button>
                )}
              </div>
            )}
          </div>
        </form>
      </div>
    </SettingsPage>
  );
}
