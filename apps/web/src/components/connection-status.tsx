import { useApiHealth } from '../hooks/use-api-health';
import { useSocketStatus } from '../hooks/use-socket-status';

function Pill({ label, state }: { label: string; state: 'ok' | 'warn' | 'down' | 'idle' }) {
  const dot =
    state === 'ok'
      ? 'bg-emerald-500'
      : state === 'warn'
        ? 'bg-amber-500'
        : state === 'down'
          ? 'bg-rose-500'
          : 'bg-slate-300';
  const ring =
    state === 'ok'
      ? 'border-emerald-200 text-emerald-700'
      : state === 'warn'
        ? 'border-amber-200 text-amber-700'
        : state === 'down'
          ? 'border-rose-200 text-rose-700'
          : 'border-slate-200 text-slate-500';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${ring}`}
      title={`${label}: ${state}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function ConnectionStatusBar() {
  const apiHealth = useApiHealth();
  const socket = useSocketStatus();

  const apiState: 'ok' | 'warn' | 'down' = apiHealth.isError
    ? 'down'
    : apiHealth.data?.status === 'ok'
      ? 'ok'
      : apiHealth.data?.status === 'degraded'
        ? 'warn'
        : apiHealth.isLoading
          ? 'warn'
          : 'down';

  const wsState: 'ok' | 'warn' | 'down' | 'idle' =
    socket === 'connected'
      ? 'ok'
      : socket === 'connecting'
        ? 'warn'
        : socket === 'disconnected'
          ? 'down'
          : 'idle';

  return (
    <div className="flex items-center gap-2">
      <Pill label="API" state={apiState} />
      <Pill label="Realtime" state={wsState} />
    </div>
  );
}
