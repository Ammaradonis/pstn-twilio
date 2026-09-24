import type { useVoiceDevice } from '../hooks/use-voice-device';

type Props = { voice: ReturnType<typeof useVoiceDevice> };

export function MicrophonePicker({ voice }: Props) {
  const inputs = voice.microphoneInputs ?? [];
  const routes = inputs.filter(
    (input) => input.deviceId !== 'default' && input.deviceId !== 'communications',
  );
  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-700">Microphone</h2>
      <div role="group" aria-label="Microphone choice" className="mt-2 flex flex-wrap gap-2">
        {[{ deviceId: '', label: 'Automatic' }, ...routes].map((input) => (
          <button
            key={input.deviceId}
            type="button"
            aria-pressed={(voice.selectedMicrophoneId ?? '') === input.deviceId}
            disabled={voice.microphoneBusy || !voice.browserSupported}
            onClick={() => void voice.selectMicrophone(input.deviceId)}
            className={`rounded border px-3 py-2 text-sm disabled:opacity-60 ${(voice.selectedMicrophoneId ?? '') === input.deviceId ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-800'}`}
          >
            {input.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void voice.refreshMicrophones()}
          disabled={!voice.browserSupported}
          className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
        >
          Refresh microphones
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {voice.micPermission !== 'granted' && 'Enable microphone access to see your choices. '}
        On Android, earpiece and speakerphone choices also change call playback. The Galaxy A36
        browser does not reliably expose separate top and bottom microphones; Android chooses the
        microphones for each route. Separate microphones can only be selected if your browser lists
        them.
      </p>
      {voice.microphoneError && (
        <p role="alert" className="mt-2 text-xs text-rose-700">
          {voice.microphoneError}
        </p>
      )}
    </div>
  );
}
