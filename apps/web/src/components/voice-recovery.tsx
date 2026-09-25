import type { useVoiceDevice } from '../hooks/use-voice-device';

export function VoiceRecovery({ voice }: { voice: ReturnType<typeof useVoiceDevice> }) {
  if (!voice.reconnecting && !voice.recoveryFailed) return null;
  const busy = voice.active || Boolean(voice.incoming);
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p role="status">
        {voice.recoveryFailed
          ? 'Voice connection unavailable. Check your network and reconnect.'
          : 'Restoring the voice connection. Recovery is limited to 30 seconds.'}
      </p>
      {busy && <p className="mt-1 text-xs">End the current call before manually reconnecting.</p>}
      <button
        type="button"
        onClick={voice.retryConnection}
        disabled={busy}
        className="mt-2 rounded border border-amber-400 bg-white px-3 py-2 font-medium disabled:opacity-50"
      >
        Reconnect voice
      </button>
    </div>
  );
}
