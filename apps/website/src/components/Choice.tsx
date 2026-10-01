import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";

/** Radio cards: a ring, a title and one sentence of consequence. */
export function RadioCards({
  name,
  defaultValue,
  options,
  label,
}: {
  name: string;
  defaultValue: string;
  options: { value: string; title: string; description: string; icon?: ReactNode }[];
  label: string;
}) {
  return (
    <RadioGroup
      name={name}
      defaultValue={defaultValue}
      aria-label={label}
      className="flex flex-col gap-1"
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className="mk-radio-card w-full border-0 bg-transparent text-left text-ink"
        >
          <span className="mk-radio-ring mt-0.5" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 font-semibold">
              {option.icon}
              {option.title}
            </span>
            <span className="block text-body-sm text-ink-muted">{option.description}</span>
          </span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

/** A segmented control: two to four equal choices on a sunken track. */
export function Segmented({
  name,
  defaultValue,
  options,
  label,
}: {
  name: string;
  defaultValue: string;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <RadioGroup
      name={name}
      defaultValue={defaultValue}
      aria-label={label}
      className="mk-segmented self-start"
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className="mk-segment whitespace-nowrap"
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
