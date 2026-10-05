import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type {
  AssistantSkillInvocation,
  AssistantSkillSummary,
} from "../../shared/assistant-skills.ts";
import { MATCH_RANK, matchFields } from "../../shared/search.ts";
import { edge, FRESH, move, reconcile, type Selection } from "../palette/selection.ts";

const SOURCE = {
  builtin: "Built-in skill",
  personal: "Personal skill",
  repository: "Repository skill",
};

export function SkillReceipt({ skill }: { skill: AssistantSkillInvocation }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-body-sm text-ink-muted">
      <span className="text-ink">Used /{skill.name}</span>
      <span>{SOURCE[skill.source]}</span>
    </div>
  );
}

/** Completion only edits the visible draft; the server resolves the sent command. */
export function useSkillPicker({
  repo,
  draft,
  setDraft,
  input,
}: {
  repo: string | undefined;
  draft: string;
  setDraft: (value: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
}) {
  const listId = useId();
  const [catalog, setCatalog] = useState<{
    repo: string | undefined;
    skills: AssistantSkillSummary[];
  }>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [selection, setSelection] = useState<Selection>(FRESH);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    const update = () => setRefresh((value) => value + 1);
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    const query = repo ? `?${new URLSearchParams({ repo })}` : "";
    void fetch(`/api/assistant/skills${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Skills unavailable");
        return (await response.json()) as { skills: AssistantSkillSummary[] };
      })
      .then(({ skills }) => {
        if (!controller.signal.aborted) setCatalog({ repo, skills });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCatalog(undefined);
          setFailed(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [repo, refresh]);

  const token = /^\/([^\s]*)/.exec(draft);
  const query = token?.[1] ?? "";
  const open =
    focused && !dismissed && !composing && !!token && caret > 0 && caret <= token[0].length;
  const options = (catalog?.repo === repo ? (catalog?.skills ?? []) : [])
    .map((skill) => ({
      skill,
      match: matchFields(query, {
        identifiers: [skill.name],
        names: [skill.name],
        searched: [skill.description],
      }),
    }))
    .filter(({ match }) => !query || match !== null)
    .sort((a, b) => (a.match ? MATCH_RANK[a.match] : 0) - (b.match ? MATCH_RANK[b.match] : 0))
    .map(({ skill }) => skill);
  const ids = options.map((skill) => skill.id);
  const active = reconcile(selection, ids);
  const index = ids.indexOf(active.id ?? "");
  const activeId = open && index >= 0 ? `${listId}-${index}` : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const choose = (skill: AssistantSkillSummary) => {
    if (!token) return;
    const prefix = `/${skill.name} `;
    const rest = draft.slice(token[0].length).replace(/^[ \t]/, "");
    setDraft(prefix + rest);
    setDismissed(true);
    input.current?.focus();
    requestAnimationFrame(() => input.current?.setSelectionRange(prefix.length, prefix.length));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing || event.nativeEvent.isComposing || event.keyCode === 229) return true;
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelection(move(active, ids, event.key === "ArrowDown" ? 1 : -1));
    } else if ((event.key === "Home" || event.key === "End") && event.ctrlKey) {
      event.preventDefault();
      setSelection(edge(ids, event.key === "Home" ? "first" : "last"));
    } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && index >= 0) {
      event.preventDefault();
      choose(options[index]!);
    } else return false;
    return true;
  };

  return {
    onKeyDown,
    field: {
      "aria-autocomplete": "list" as const,
      "aria-haspopup": "listbox" as const,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": activeId,
      onFocus: () => {
        setFocused(true);
        setRefresh((value) => value + 1);
      },
      onBlur: () => setFocused(false),
      onSelect: () => setCaret(input.current?.selectionStart ?? 0),
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: () => setComposing(false),
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
        setDraft(event.currentTarget.value);
        setCaret(event.currentTarget.selectionStart);
        setDismissed(false);
        setSelection(FRESH);
      },
    },
    popup: open ? (
      <div className="min-h-0 shrink overflow-y-auto rounded-control bg-pane shadow-[inset_0_0_0_1px_var(--line-soft)]">
        <div id={`${listId}-label`} className="px-3 pt-2 text-body-sm font-semibold text-ink">
          Assistant skills
        </div>
        {!!options.length && (
          <span role="status" className="sr-only">
            {options.length} {options.length === 1 ? "skill" : "skills"}. Use arrow keys to choose,
            Enter or Tab to complete, Escape to dismiss.
          </span>
        )}
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={`${listId}-label`}
          className="m-0 max-h-48 list-none overflow-y-auto p-1"
        >
          {options.map((skill, at) => (
            <li
              key={skill.id}
              id={`${listId}-${at}`}
              role="option"
              aria-selected={active.id === skill.id}
              className={`min-h-11 cursor-pointer rounded-control px-2 py-2 text-body-sm [overflow-wrap:anywhere] ${active.id === skill.id ? "bg-signal-wash text-ink" : "text-ink hover:bg-pressed"}`}
              onPointerMove={() => setSelection({ id: skill.id, chosen: true })}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(skill)}
            >
              <span className="block font-medium">/{skill.name}</span>
              <span className="block text-ink-muted">{skill.description || "No description"}</span>
            </li>
          ))}
        </ul>
        {!options.length && (
          <p role="status" className="m-0 px-3 pb-2 text-body-sm text-ink-muted">
            {loading
              ? "Loading skills…"
              : failed
                ? "Skills unavailable. You can still send your message; focus the message box to try again."
                : "No matching skills. Send as a regular message."}
          </p>
        )}
      </div>
    ) : null,
  };
}
