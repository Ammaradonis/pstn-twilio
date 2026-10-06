import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { invalidateKinds } from '../hooks/use-voice-data';
import { formatTimer } from '../lib/format';
import { voiceApi } from '../lib/voice-api';

import { Icon } from './icons';
import { Spinner, useSnackbar, errorMessage } from './ui';

/** Play/pause with a seek bar. Loads the audio on first play and marks it heard. */
export function VoicemailPlayer({
  id,
  durationSeconds,
  heard,
}: {
  id: string;
  durationSeconds: number | null;
  heard: boolean;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState(durationSeconds ?? 0);
  const snackbar = useSnackbar();
  const queryClient = useQueryClient();

  useEffect(
    () => () => {
      audio.current?.pause();
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  async function toggle() {
    if (playing) {
      audio.current?.pause();
      return;
    }
    if (!url) {
      setLoading(true);
      try {
        const blob = await voiceApi.voicemailAudio(id);
        const objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        const element = new Audio(objectUrl);
        element.ontimeupdate = () => setPosition(element.currentTime);
        element.onloadedmetadata = () => {
          if (Number.isFinite(element.duration)) setLength(element.duration);
        };
        element.onplay = () => setPlaying(true);
        element.onpause = () => setPlaying(false);
        element.onended = () => {
          setPlaying(false);
          setPosition(0);
        };
        audio.current = element;
      } catch (err) {
        snackbar(errorMessage(err));
        return;
      } finally {
        setLoading(false);
      }
    }
    await audio.current?.play().catch(() => undefined);
    if (!heard) {
      void voiceApi
        .voicemailHeard(id)
        .then(() => invalidateKinds(queryClient, ['voicemail']))
        .catch(() => undefined);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-label={playing ? 'Pause' : 'Play voicemail'}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gv-blue text-white hover:bg-gv-blue-dark"
      >
        {loading ? (
          <Spinner className="h-5 w-5 border-white border-t-transparent" />
        ) : (
          <Icon name={playing ? 'pause' : 'play'} className="h-6 w-6" />
        )}
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(1, length)}
        step={0.1}
        value={position}
        aria-label="Position"
        onChange={(event) => {
          const next = Number(event.target.value);
          setPosition(next);
          if (audio.current) audio.current.currentTime = next;
        }}
        className="h-1 flex-1 cursor-pointer accent-gv-blue"
      />
      <span className="w-20 text-right text-xs tabular-nums text-gv-muted">
        {formatTimer(position)} / {formatTimer(length)}
      </span>
    </div>
  );
}
