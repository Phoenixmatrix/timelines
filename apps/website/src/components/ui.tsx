import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import { Toast } from "@base-ui/react/toast";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  CaretUpDownIcon,
  CheckIcon,
  CopyIcon,
  GlobeSimpleIcon,
  LockSimpleIcon,
} from "@phosphor-icons/react";
import { useId, useState, type ReactElement, type ReactNode } from "react";
import type { RepoRole, Visibility } from "../../shared/api.ts";

/** Every icon-only control gets a tooltip (and an aria-label on the control). */
export function Tip({
  label,
  side = "top",
  children,
}: {
  label: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactElement;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={8} className="z-[60]">
          <Tooltip.Popup className="mk-tooltip gm-pop">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const ROLE_LABEL: Record<RepoRole, string> = {
  admin: "Admin",
  write: "Can push",
  read: "Read only",
  none: "No access",
};

export function RoleChip({ role }: { role: RepoRole }) {
  return <span className="mk-chip mk-chip--tag">{ROLE_LABEL[role]}</span>;
}

export function VisibilityChip({ visibility }: { visibility: Visibility }) {
  const Icon = visibility === "private" ? LockSimpleIcon : GlobeSimpleIcon;
  return (
    <span className="mk-chip mk-chip--tag gap-1">
      <Icon weight="bold" className="size-3" aria-hidden />
      {visibility === "private" ? "Private" : "Public"}
    </span>
  );
}

export function useToast() {
  return Toast.useToastManager();
}

export function Toasts() {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed top-16 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((toast) => (
          <Toast.Root key={toast.id} toast={toast} className="mk-toast gm-toast">
            <div className="mk-toast-body">
              <Toast.Title className="mk-toast-title" />
              <Toast.Description className="mk-toast-desc" />
            </div>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

/** A read-only value (a URL, a token) with a copy button beside it. */
export function CopyField({
  value,
  label,
  mono = true,
}: {
  value: string;
  label: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.add({ title: `${label} copied` });
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex gap-2">
      <input
        className={`mk-input min-w-0 flex-1 ${mono ? "mk-input--code text-body-sm" : ""}`}
        value={value}
        readOnly
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Tip label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}>
        <button
          type="button"
          className="mk-btn mk-btn--icon h-11 w-11"
          onClick={copy}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <CheckIcon weight="bold" /> : <CopyIcon weight="bold" />}
        </button>
      </Tip>
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectField({
  name,
  value,
  defaultValue,
  options,
  onChange,
  ariaLabel,
  className = "",
}: {
  name?: string;
  value?: string;
  defaultValue?: string;
  options: SelectOption[];
  onChange?: (value: string) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <Select.Root
      name={name}
      value={value}
      defaultValue={defaultValue}
      items={options}
      onValueChange={(next) => next !== null && onChange?.(next)}
    >
      <Select.Trigger className={`mk-input mk-select ${className}`} aria-label={ariaLabel}>
        <Select.Value className="truncate" />
        <Select.Icon render={<CaretUpDownIcon className="mk-icon" />} />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-50">
          <Select.Popup className="mk-popup gm-pop min-w-[var(--anchor-width)]">
            <Select.List>
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className="mk-option"
                  title={option.label}
                >
                  {/* The kit shows this check on the option with aria-selected="true". */}
                  <span className="mk-option-check">
                    <CheckIcon weight="bold" />
                  </span>
                  <Select.ItemText className="truncate">{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/** A destructive confirm: names the thing and the result; ghost "Keep it" on the left. */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy = false,
}: {
  trigger: ReactElement;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger render={trigger} />
      <Dialog.Portal>
        <Dialog.Backdrop className="mk-backdrop gm-fade" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Popup className="mk-dialog gm-dialog">
            <Dialog.Title className="mk-dialog-title">{title}</Dialog.Title>
            <Dialog.Description className="mk-dialog-desc">{description}</Dialog.Description>
            <div className="mk-dialog-actions">
              <Dialog.Close className="mk-btn mk-btn--ghost">Keep it</Dialog.Close>
              <button
                type="button"
                className="mk-btn mk-btn--danger"
                onClick={onConfirm}
                disabled={busy}
              >
                {confirmLabel}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Card({
  title,
  description,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`mk-card ${className}`}>
      {title && <h2 className="mk-card-title">{title}</h2>}
      {description && <p className="mk-card-desc">{description}</p>}
      {children}
    </section>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="mk-error m-0" role="alert">
      {message}
    </p>
  );
}

/** A labelled text input; the hint is linked as its description, not its name. */
export function TextField({
  label,
  hint,
  className = "",
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className={`mk-field ${className}`}>
      <label htmlFor={id} className="mk-label">
        {label}
      </label>
      <input
        id={id}
        className="mk-input"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint && (
        <span id={`${id}-hint`} className="mk-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
