import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: string;
  tone: ToastTone;
  title?: string;
  message: string;
  durationMs: number;
}

interface ToastContextValue {
  toasts: Toast[];
  push: (input: Omit<Toast, 'id' | 'durationMs'> & { durationMs?: number }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastContextValue['push']>(({ tone, title, message, durationMs }) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const toast: Toast = {
      id,
      tone,
      title,
      message,
      durationMs: durationMs ?? (tone === 'error' ? 8000 : 4000),
    };
    setToasts((prev) => [...prev, toast]);
    return id;
  }, []);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

const TONE_STYLES: Record<ToastTone, string> = {
  info: 'border-slate-300 bg-white text-slate-900',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  warn: 'border-amber-300 bg-amber-50 text-amber-900',
  error: 'border-rose-300 bg-rose-50 text-rose-900',
};

function Toaster() {
  const { toasts, dismiss } = useToast();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex flex-col items-center gap-2 px-2 sm:right-4 sm:top-4 sm:items-end sm:px-0">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast.durationMs, onDismiss]);

  return (
    <div
      role="status"
      className={`pointer-events-auto w-full max-w-sm rounded border p-3 shadow-sm ${TONE_STYLES[toast.tone]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm">
          {toast.title && <p className="font-semibold">{toast.title}</p>}
          <p className={toast.title ? 'mt-0.5' : undefined}>{toast.message}</p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="text-xs text-slate-500 hover:text-slate-900"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
