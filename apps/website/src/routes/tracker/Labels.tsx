import { useId, useMemo, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { XIcon } from "@phosphor-icons/react";
import { popMotion } from "../../components/ui.tsx";

type TagOption = { value: string; label: string };

export function LabelPicker({
  options,
  values,
  onChange,
  disabled = false,
}: {
  options: string[];
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const name = query.trim();
  const folded = name.toLowerCase();
  const catalog = useMemo(() => {
    const unique = new Map<string, string>();
    for (const value of [...options, ...values]) {
      const key = value.toLowerCase();
      if (!unique.has(key)) unique.set(key, value);
    }
    return unique;
  }, [options, values]);
  const selected = new Set(values.map((value) => value.toLowerCase()));
  const invalid = name.includes("\0")
    ? "Tags cannot contain a null character."
    : name.length > 100
      ? "Use 100 characters or fewer for a tag."
      : "";
  const items: TagOption[] = [...catalog.values()]
    .filter((value) => !selected.has(value.toLowerCase()) && value.toLowerCase().includes(folded))
    .map((value) => ({ value, label: value }));
  if (name && !invalid && !catalog.has(folded))
    items.push({ value: name, label: `Create tag “${name}”` });

  return (
    <div className="mk-field min-w-0">
      <label className="mk-label" htmlFor={id}>
        Tags
      </label>
      {values.length > 0 && (
        <ul className="m-0 mb-2 flex list-none flex-wrap gap-1 p-0" aria-label="Selected tags">
          {values.map((value) => (
            <li key={value} className="min-w-0 max-w-full">
              <button
                type="button"
                className="mk-btn mk-btn--sm max-w-full gap-1 text-body-sm"
                aria-label={`Remove tag ${value}`}
                disabled={disabled}
                onClick={() => onChange(values.filter((current) => current !== value))}
              >
                <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{value}</span>
                <XIcon className="size-3 shrink-0" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Combobox.Root<TagOption>
        items={items}
        filter={null}
        value={null}
        inputValue={query}
        onInputValueChange={(value, details) =>
          setQuery(details.reason === "item-press" ? "" : value)
        }
        disabled={disabled}
        onValueChange={(item) => {
          if (!item) return;
          const value = catalog.get(item.value.toLowerCase()) ?? item.value;
          if (!selected.has(value.toLowerCase())) onChange([...values, value]);
          setQuery("");
        }}
      >
        <Combobox.Input
          id={id}
          className="mk-input"
          placeholder="Find or create a tag…"
          aria-describedby={`${id}-hint`}
          aria-invalid={!!invalid}
        />
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={6} className="z-50">
            <Combobox.Popup
              className={`mk-popup ${popMotion} max-h-[min(360px,var(--available-height))] w-(--anchor-width) max-w-[calc(100vw-32px)] overflow-y-auto`}
            >
              <Combobox.Empty className="mk-hint p-3">
                {invalid ||
                  (selected.has(folded) ? "This tag is already selected." : "No matching tags.")}
              </Combobox.Empty>
              <Combobox.List>
                {(item: TagOption) => (
                  <Combobox.Item
                    key={item.value}
                    value={item}
                    className="mk-option py-1.5 text-body-sm whitespace-normal [overflow-wrap:anywhere]"
                  >
                    {item.label}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      <p id={`${id}-hint`} className="mk-hint m-0 mt-1">
        {invalid || "Choose a tag, or type a name and choose Create tag."}
      </p>
    </div>
  );
}
