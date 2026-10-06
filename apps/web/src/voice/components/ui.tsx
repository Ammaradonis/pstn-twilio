// Small building blocks shared by the voice app's screens.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { avatarColor, initials } from '../lib/format';

import { Icon, type IconName } from './icons';

export function Avatar({
  name,
  seed,
  size = 'md',
}: {
  name: string | null | undefined;
  seed: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const letters = name ? initials(name) : '';
  const dims = {
    sm: 'h-8 w-8 text-sm',
    md: 'h-10 w-10 text-base',
    lg: 'h-16 w-16 text-2xl',
    xl: 'h-24 w-24 text-4xl',
  }[size];
  const iconSize = { sm: 'h-5 w-5', md: 'h-6 w-6', lg: 'h-9 w-9', xl: 'h-14 w-14' }[size];
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white ${dims} ${
        letters ? avatarColor(seed) : 'bg-[#9aa0a6]'
      }`}
    >
      {letters || <Icon name="person" className={iconSize} />}
    </span>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  className = '',
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-gv-muted hover:bg-gv-soft active:bg-gv-line disabled:opacity-40 ${className}`}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-gv-blue' : 'bg-[#bdc1c6]'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

/** A panel that slides up from the bottom on phones and is centered on larger screens. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center sm:items-center"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-black/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative max-h-[90vh] w-full overflow-y-auto rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl sm:rounded-3xl ${
          wide ? 'sm:max-w-lg' : 'sm:max-w-md'
        }`}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-gv-line sm:hidden" />
        {title ? <h2 className="px-6 pb-2 pt-4 text-lg font-medium text-gv-ink">{title}</h2> : null}
        {children}
      </div>
    </div>
  );
}

export function SheetAction({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-4 px-6 py-3 text-left text-[15px] hover:bg-gv-soft ${
        danger ? 'text-gv-red' : 'text-gv-ink'
      }`}
    >
      <Icon name={icon} className={`h-6 w-6 ${danger ? 'text-gv-red' : 'text-gv-muted'}`} />
      {label}
    </button>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      <span className="flex h-20 w-20 items-center justify-center rounded-full bg-gv-blue-soft text-gv-blue">
        <Icon name={icon} className="h-10 w-10" />
      </span>
      <p className="mt-5 text-lg text-gv-ink">{title}</p>
      {body ? <p className="mt-1 max-w-xs text-sm text-gv-muted">{body}</p> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  type = 'button',
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full bg-gv-blue px-6 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-gv-blue-dark disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function TextButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-4 py-2 text-sm font-medium hover:bg-gv-blue-soft disabled:opacity-50 ${
        danger ? 'text-gv-red hover:bg-red-50' : 'text-gv-blue'
      }`}
    >
      {children}
    </button>
  );
}

export function Spinner({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-gv-blue border-t-transparent ${className}`}
    />
  );
}

export function PageLoading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  );
}

// Bottom snackbar messages, like the phone's own.
interface SnackbarMessage {
  id: number;
  text: string;
  action?: { label: string; onClick: () => void };
}

const SnackbarContext = createContext<(text: string, action?: SnackbarMessage['action']) => void>(
  () => undefined,
);

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<SnackbarMessage | null>(null);
  const counter = useRef(0);
  const show = useCallback((text: string, action?: SnackbarMessage['action']) => {
    counter.current += 1;
    setMessage({ id: counter.current, text, action });
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), message.action ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [message]);
  const value = useMemo(() => show, [show]);
  return (
    <SnackbarContext.Provider value={value}>
      {children}
      {message ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4 md:bottom-6">
          <div
            role="status"
            className="pointer-events-auto flex max-w-md items-center gap-4 rounded-lg bg-[#323232] px-4 py-3 text-sm text-white shadow-lg"
          >
            <span>{message.text}</span>
            {message.action ? (
              <button
                type="button"
                className="font-medium text-[#8ab4f8]"
                onClick={() => {
                  message.action?.onClick();
                  setMessage(null);
                }}
              >
                {message.action.label}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </SnackbarContext.Provider>
  );
}

export function useSnackbar() {
  return useContext(SnackbarContext);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
