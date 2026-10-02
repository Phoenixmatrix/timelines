import { useState } from "react";
import type { Snapshot } from "../../../shared/tracker.ts";
import { FormError, SelectField } from "../../components/ui.tsx";
import { VIEWS } from "./query.ts";
import {
  initialTrackerDefaults,
  saveTrackerDefaults,
  VIEW_LABEL,
  type TrackerDefaults,
  type View,
} from "./preferences.ts";

export function TrackerDefaultsForm({
  viewerId,
  snapshot,
  defaults,
  onSaved,
  onCancel,
}: {
  viewerId: string;
  snapshot: Snapshot;
  defaults: TrackerDefaults | null;
  onSaved: (defaults: TrackerDefaults | null) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => initialTrackerDefaults(defaults, snapshot));
  const [error, setError] = useState("");
  const save = (next: TrackerDefaults | null) => {
    try {
      saveTrackerDefaults(viewerId, next);
    } catch {
      setError("Your browser could not save these defaults. Allow site storage and try again.");
      return;
    }
    onSaved(next);
  };

  return (
    <section className="rounded-pane bg-pane p-4" aria-labelledby="tracker-defaults-title">
      <h2 id="tracker-defaults-title" className="m-0 text-title">
        Default view and team
      </h2>
      <p className="mt-1 mb-4 text-body-sm text-ink-muted">
        Open Issues in {snapshot.owner.displayName} with these defaults. Saved for your account in
        this browser; links with explicit filters take precedence.
      </p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save(draft);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-1 text-field-label">
            Layout
            <SelectField
              ariaLabel="Default layout"
              value={draft.view}
              options={Object.entries(VIEW_LABEL).map(([value, label]) => ({ value, label }))}
              onChange={(view) => setDraft({ ...draft, view: view as View })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-field-label">
            Issue view
            <SelectField
              ariaLabel="Default issue view"
              value={draft.query}
              options={VIEWS.map((view) => ({ value: view.query, label: view.label }))}
              onChange={(query) => setDraft({ ...draft, query })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-field-label">
            Team
            <SelectField
              ariaLabel="Default team"
              value={draft.teamId}
              options={[
                { value: "", label: "All teams" },
                ...snapshot.teams
                  .filter((team) => !team.archived)
                  .map((team) => ({ value: team.id, label: `${team.key} · ${team.name}` })),
              ]}
              onChange={(teamId) => setDraft({ ...draft, teamId })}
            />
          </div>
        </div>
        <p className="m-0 text-micro text-ink-muted">
          A default team also becomes the team for new issues. Archived or unavailable teams fall
          back to all teams.
        </p>
        {error && <FormError message={error} />}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="mk-btn mk-btn--primary">
            Save defaults
          </button>
          <button type="button" className="mk-btn mk-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          {defaults && (
            <button
              type="button"
              className="mk-btn mk-btn--ghost sm:ml-auto"
              onClick={() => save(null)}
            >
              Reset defaults
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
