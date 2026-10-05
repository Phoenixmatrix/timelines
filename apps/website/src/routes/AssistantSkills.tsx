import { useEffect, useId, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import {
  ASSISTANT_SKILL_LIMITS,
  type PersonalAssistantSkill,
  type PersonalAssistantSkillInput,
} from "../../shared/assistant-skills.ts";
import { SettingsPage } from "../components/SettingsPage.tsx";
import { Card, ConfirmDialog, FormError, TextField } from "../components/ui.tsx";
import { api, ApiError, field } from "../lib/api.ts";
import { requireViewer } from "../lib/session.ts";

export async function assistantSkillsLoader({ request }: { request: Request }) {
  await requireViewer(request);
  try {
    const { skills } = await api<{ skills: PersonalAssistantSkill[] }>("/account/skills", {
      signal: request.signal,
    });
    return { skills, error: null };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return {
      skills: null,
      error: error instanceof ApiError ? error.message : "Could not load your skills. Try again.",
    };
  }
}

type Result =
  | { error: string }
  | { saved: "add" | "save" | "toggle"; name: string }
  | { removed: true };

export async function assistantSkillsAction({ request }: { request: Request }): Promise<Result> {
  const form = await request.formData();
  const intent = field(form, "intent");
  const id = encodeURIComponent(field(form, "id"));
  try {
    if (intent === "remove") {
      await api(`/account/skills/${id}`, { method: "DELETE" });
      return { removed: true };
    }
    const input: PersonalAssistantSkillInput = {
      name: field(form, "name"),
      description: field(form, "description"),
      body: field(form, "body"),
      enabled: field(form, "enabled") === "true",
    };
    const adding = intent === "add";
    const { skill } = await api<{ skill: PersonalAssistantSkill }>(
      adding ? "/account/skills" : `/account/skills/${id}`,
      { method: adding ? "POST" : "PUT", json: input },
    );
    return { saved: adding ? "add" : intent === "toggle" ? "toggle" : "save", name: skill.name };
  } catch (error) {
    return {
      error:
        error instanceof ApiError
          ? error.message
          : "Could not save your changes. Your draft is still here; try again.",
    };
  }
}

export function AssistantSkills() {
  const { skills, error } = useLoaderData<typeof assistantSkillsLoader>();
  const revalidator = useRevalidator();
  const add = useFetcher<typeof assistantSkillsAction>();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (add.state === "idle" && add.data && "saved" in add.data) form.current?.reset();
  }, [add.state, add.data]);

  return (
    <SettingsPage>
      <h1 className="m-0 text-headline">Assistant skills</h1>
      <p className="mt-1.5 mb-0 max-w-[65ch] text-ink-muted">
        Save personal instructions, then start an assistant message with{" "}
        <code className="mk-mono">/name</code> to use them for that turn. These skills belong only
        to you, across your repositories. They do not change permissions or approval requirements.
      </p>
      <p className="mt-3 mb-0 max-w-[65ch] text-body-sm text-ink-muted">
        Built-in skill names are reserved. An enabled personal skill takes precedence over a
        repository skill with the same name.
      </p>
      <div className="mt-8 flex flex-col gap-6">
        <Card title="Add an assistant skill">
          <add.Form
            method="post"
            ref={form}
            aria-label="Add an assistant skill"
            className="mk-card-body"
          >
            <input type="hidden" name="intent" value="add" />
            <SkillFields disabled={add.state !== "idle"} />
            <FormError message={add.data && "error" in add.data ? add.data.error : null} />
            {add.state === "idle" && add.data && "saved" in add.data && (
              <p role="status" className="m-0 text-body-sm text-ink-muted">
                Added /{add.data.name}.
              </p>
            )}
            <div>
              <button
                className="mk-btn mk-btn--primary pointer-coarse:min-h-11"
                disabled={add.state !== "idle"}
              >
                {add.state !== "idle" ? "Adding…" : "Add skill"}
              </button>
            </div>
          </add.Form>
        </Card>
        <Card title="Your assistant skills">
          <div className="mk-card-body">
            <FormError message={error} />
            {error && (
              <div>
                <button
                  type="button"
                  className="mk-btn mk-btn--secondary pointer-coarse:min-h-11"
                  disabled={revalidator.state !== "idle"}
                  onClick={() => void revalidator.revalidate()}
                >
                  Try again
                </button>
              </div>
            )}
            {revalidator.state !== "idle" && (
              <p role="status" className="m-0 text-body-sm text-ink-muted">
                Loading your skills…
              </p>
            )}
            {skills?.length === 0 && (
              <p className="m-0 text-ink-muted">
                No personal skills yet. Add instructions above to give a recurring task its own
                slash command.
              </p>
            )}
            {skills && skills.length > 0 && (
              <ul
                aria-label="Your assistant skills"
                className="m-0 list-none divide-y divide-line p-0"
              >
                {skills.map((skill) => (
                  <SkillRow key={skill.id} skill={skill} />
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </SettingsPage>
  );
}

function SkillFields({ skill, disabled }: { skill?: PersonalAssistantSkill; disabled: boolean }) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
      <TextField
        label="Name"
        name="name"
        defaultValue={skill?.name ?? ""}
        required
        maxLength={ASSISTANT_SKILL_LIMITS.name}
        pattern={"[a-z0-9][a-z0-9\\-]{0,63}"}
        autoCapitalize="none"
        spellCheck={false}
        hint="Lowercase letters, digits and hyphens; start with a letter or digit. Do not include the slash."
      />
      <TextField
        label="Description (optional)"
        name="description"
        defaultValue={skill?.description ?? ""}
        maxLength={ASSISTANT_SKILL_LIMITS.description}
        hint="A short reminder shown in the assistant’s skill picker."
      />
      <div className="mk-field">
        <label htmlFor={id} className="mk-label">
          Markdown instructions
        </label>
        <textarea
          id={id}
          name="body"
          defaultValue={skill?.body ?? ""}
          required
          rows={8}
          maxLength={ASSISTANT_SKILL_LIMITS.body}
          className="mk-input min-h-32 resize-y"
          aria-describedby={`${id}-hint`}
        />
        <span id={`${id}-hint`} className="mk-hint">
          Describe how the assistant should carry out this task. Instructions apply only when you
          invoke this skill.
        </span>
      </div>
      <label className="flex items-center gap-2 text-body-sm pointer-coarse:min-h-11">
        <input
          type="checkbox"
          name="enabled"
          value="true"
          defaultChecked={skill?.enabled ?? true}
        />{" "}
        Enabled
      </label>
    </fieldset>
  );
}

function SkillRow({ skill }: { skill: PersonalAssistantSkill }) {
  const fetcher = useFetcher<typeof assistantSkillsAction>();
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const editForm = useRef<HTMLFormElement>(null);
  const busy = fetcher.state !== "idle";
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data &&
      "saved" in fetcher.data &&
      fetcher.data.saved === "save"
    ) {
      setEditing(false);
      editButton.current?.focus();
    }
  }, [fetcher.state, fetcher.data]);
  useEffect(() => {
    if (editing) editForm.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
  }, [editing]);

  return (
    <li aria-label={`/${skill.name}`} className="flex min-w-0 flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 max-sm:basis-full">
          <h3 className="m-0 break-all text-title">
            <code className="mk-mono">/{skill.name}</code>
          </h3>
          <p className="mt-1 mb-0 break-words text-body-sm text-ink-muted">
            {skill.description || "No description"}
          </p>
        </div>
        <label className="flex items-center gap-2 text-body-sm pointer-coarse:min-h-11">
          <input
            type="checkbox"
            checked={skill.enabled}
            aria-label={`Enable /${skill.name}`}
            disabled={busy || editing}
            onChange={(event) =>
              fetcher.submit(
                {
                  intent: "toggle",
                  id: skill.id,
                  name: skill.name,
                  description: skill.description,
                  body: skill.body,
                  enabled: String(event.target.checked),
                },
                { method: "post" },
              )
            }
          />
          {skill.enabled ? "Enabled" : "Disabled"}
        </label>
        <button
          type="button"
          ref={editButton}
          className="mk-btn mk-btn--ghost mk-btn--sm pointer-coarse:min-h-11"
          aria-label={`Edit /${skill.name}`}
          aria-expanded={editing}
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <ConfirmDialog
          trigger={
            <button
              type="button"
              className="mk-btn mk-btn--danger-ghost mk-btn--sm pointer-coarse:min-h-11"
              aria-label={`Remove /${skill.name}`}
              disabled={busy || editing}
            >
              Remove
            </button>
          }
          title={`Remove /${skill.name}?`}
          description={
            <>
              <span>
                This removes your personal instructions. A repository skill with the same name may
                become available instead.
              </span>
              {error && (
                <span role="alert" className="mk-error mt-2 block">
                  {error}
                </span>
              )}
            </>
          }
          confirmLabel={busy ? "Removing…" : "Remove skill"}
          busy={busy}
          onConfirm={() => fetcher.submit({ intent: "remove", id: skill.id }, { method: "post" })}
        />
      </div>
      {editing && (
        <fetcher.Form
          method="post"
          ref={editForm}
          aria-label={`Edit /${skill.name}`}
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="id" value={skill.id} />
          <SkillFields skill={skill} disabled={busy} />
          <div className="flex flex-wrap gap-2">
            <button className="mk-btn mk-btn--primary pointer-coarse:min-h-11" disabled={busy}>
              {busy ? "Saving…" : "Save skill"}
            </button>
            <button
              type="button"
              className="mk-btn mk-btn--ghost pointer-coarse:min-h-11"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                editButton.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </fetcher.Form>
      )}
      <FormError message={error} />
      {busy && (
        <p role="status" className="m-0 text-body-sm text-ink-muted">
          Applying changes…
        </p>
      )}
      {!busy && fetcher.data && "saved" in fetcher.data && (
        <p role="status" className="m-0 text-body-sm text-ink-muted">
          Saved /{fetcher.data.name}.
        </p>
      )}
    </li>
  );
}
