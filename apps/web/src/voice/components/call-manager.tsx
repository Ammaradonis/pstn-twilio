/**
 * Calls in the voice app: one Twilio Device for the signed-in user, a
 * full-screen incoming call that interrupts whatever is on screen (with the
 * device's ringtone and vibration, or a system notification when the app is
 * in the background), the in-call screen, and the dialer.
 */

import {
  normalizeDialablePhoneNumber,
  WS_EVENTS,
  type WsVoiceAppCallAnsweredEvent,
} from '@pstn-twilio/shared';
import { useQueryClient } from '@tanstack/react-query';
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
import { useLocation, useNavigate } from 'react-router-dom';

import { setSdkIncomingSound, useVoiceDevice } from '../../hooks/use-voice-device';
import { useBrowserRecordingStatus } from '../../lib/browser-recordings';
import { getSocket } from '../../lib/realtime';
import { useBootstrap, useContactLookup, useContacts, voiceKeys } from '../hooks/use-voice-data';
import { KEYPAD_LETTERS, searchContacts } from '../lib/contacts';
import { deviceId, useDevicePrefs } from '../lib/device';
import { formatDialInput, formatNumber, formatTimer } from '../lib/format';
import { closeLocalNotifications, showLocalNotification } from '../lib/push';
import {
  canPlayAudio,
  playEndTone,
  playKeyTone,
  RING_VIBRATION,
  startRingback,
  startRingtone,
  unlockAudio,
  vibrate,
} from '../lib/ringtone';
import { voiceApi } from '../lib/voice-api';

import { Icon, type IconName } from './icons';
import { Avatar, useSnackbar } from './ui';

interface ActiveCall {
  number: string;
  direction: 'incoming' | 'outgoing';
  connectedAt: number | null;
  parentCallSid: string | null;
}

interface CallContextValue {
  placeCall: (number: string) => Promise<void>;
  openDialer: (initial?: string) => void;
  onCall: boolean;
  registered: boolean;
}

const CallContext = createContext<CallContextValue>({
  placeCall: async () => undefined,
  openDialer: () => undefined,
  onCall: false,
  registered: false,
});

export function useCalls(): CallContextValue {
  return useContext(CallContext);
}

// How long a notification tap may take to turn into an answered call.
const ANSWER_INTENT_MS = 25_000;

export function CallProvider({ children }: { children: ReactNode }) {
  const voice = useVoiceDevice();
  const { init, destroy, refreshMicrophones } = voice;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const snackbar = useSnackbar();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const prefs = useDevicePrefs();
  const { data: boot } = useBootstrap();
  const lookup = useContactLookup();

  const [dialer, setDialer] = useState<{ open: boolean; initial: string }>({
    open: false,
    initial: '',
  });
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [ended, setEnded] = useState<{ number: string; at: number } | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answerIntent, setAnswerIntent] = useState<{
    callSid: string;
    until: number;
    asked: boolean;
  } | null>(null);
  const ringingParent = useRef<string | null>(null);
  const answeredHere = useRef<Set<string>>(new Set());
  // The SDK has reported this call as up at least once (ended vs. still dialing).
  const sawActive = useRef(false);
  // Hung up while the call was still being set up.
  const cancelled = useRef(false);

  // The device: our own ringtone instead of the SDK's; sign out unregisters.
  useEffect(() => {
    void init();
    return () => {
      destroy();
      setSdkIncomingSound(true);
    };
  }, [init, destroy]);

  // Sound needs a tap first; any tap in the app unlocks it.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const incoming = voice.incoming;
  const incomingParent = incoming?.connection.customParameters?.get('parentCallSid') ?? null;
  const incomingName =
    incoming?.connection.customParameters?.get('callerName') ??
    lookup(incoming?.from)?.name ??
    null;
  const incomingNameRef = useRef(incomingName);
  incomingNameRef.current = incomingName;

  // Ring: ringtone, vibration, and a notification if the app isn't on screen.
  useEffect(() => {
    if (!incoming) return;
    // Before the first tap the browser mutes our synthesized ringtone, so let
    // the SDK's own ring sound instead of total silence. Once our audio is
    // live, the device switches back to the user's chosen ringtone.
    setSdkIncomingSound(!canPlayAudio());
    ringingParent.current = incomingParent;
    const stopTone = startRingtone(prefs.ringtone);
    let buzz: ReturnType<typeof setInterval> | null = null;
    if (prefs.vibrate) {
      vibrate(RING_VIBRATION);
      buzz = setInterval(
        () => vibrate(RING_VIBRATION),
        RING_VIBRATION.reduce((a, b) => a + b, 0),
      );
    }
    const tag = `call-${incomingParent ?? 'local'}`;
    if (document.visibilityState !== 'visible' && prefs.callNotifications) {
      void showLocalNotification(incomingNameRef.current ?? formatNumber(incoming.from), {
        body: 'Incoming call',
        tag,
        requireInteraction: true,
        data: {
          type: 'incoming-call',
          callSid: incomingParent,
          url: incomingParent ? `/voice/calls?answer=${incomingParent}` : '/voice/calls',
        },
      });
    }
    return () => {
      stopTone();
      if (buzz) clearInterval(buzz);
      vibrate(0);
      void closeLocalNotifications(tag);
    };
  }, [incoming, incomingParent, prefs.ringtone, prefs.vibrate, prefs.callNotifications]);

  // Outbound ringback: while the far end is ringing you hear the network's
  // "ring… ring…", the way a phone does, instead of silence.
  const ringingOut = voice.active && voice.connectionState === 'ringing';
  useEffect(() => {
    if (!ringingOut) return;
    const stop = startRingback();
    return stop;
  }, [ringingOut]);

  // Another device or a linked phone took the call.
  useEffect(() => {
    const socket = getSocket();
    const onAnswered = (payload: WsVoiceAppCallAnsweredEvent) => {
      if (payload.callSid !== ringingParent.current) return;
      if (answeredHere.current.has(payload.callSid)) return;
      if (payload.handledBy === `app:${deviceId()}`) return;
      snackbar(`Answered on ${payload.where}`);
    };
    socket.on(WS_EVENTS.VOICE_APP_CALL_ANSWERED, onAnswered);
    return () => {
      socket.off(WS_EVENTS.VOICE_APP_CALL_ANSWERED, onAnswered);
    };
  }, [snackbar]);

  const accept = useCallback(async () => {
    const current = voiceRef.current;
    if (!current.incoming || answering) return;
    unlockAudio();
    setAnswering(true);
    try {
      if (current.micPermission !== 'granted') {
        const granted = await current.requestMicPermission();
        if (!granted) {
          snackbar('Allow the microphone to answer calls');
          return;
        }
      }
      const parent = current.incoming.connection.customParameters?.get('parentCallSid') ?? null;
      if (parent) answeredHere.current.add(parent);
      setActive({
        number: current.incoming.from ?? '',
        direction: 'incoming',
        connectedAt: null,
        parentCallSid: parent,
      });
      setMinimized(false);
      await current.accept();
      if (parent) void voiceApi.answered(parent, deviceId()).catch(() => undefined);
    } finally {
      setAnswering(false);
    }
  }, [answering, snackbar]);

  const decline = useCallback(() => {
    const current = voiceRef.current;
    const parent = current.incoming?.connection.customParameters?.get('parentCallSid');
    current.reject();
    // Like the phone app: declining sends the caller to voicemail everywhere.
    if (parent) {
      answeredHere.current.add(parent);
      void voiceApi.decline(parent).catch(() => undefined);
    }
  }, []);

  // Opened from a call notification: ring this device and pick up.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const callSid = params.get('answer');
    if (!callSid) return;
    setAnswerIntent({ callSid, until: Date.now() + ANSWER_INTENT_MS, asked: false });
    params.delete('answer');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        url?: string;
        action?: string;
        callSid?: string;
      } | null;
      if (data?.type === 'voice-open' && data.url) navigate(data.url);
      if (data?.type === 'voice-action' && data.action === 'decline') decline();
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, [navigate, decline]);

  useEffect(() => {
    if (!answerIntent) return;
    if (Date.now() > answerIntent.until) {
      setAnswerIntent(null);
      return;
    }
    if (incoming && incomingParent === answerIntent.callSid) {
      setAnswerIntent(null);
      void accept();
      return;
    }
    if (!voice.registered || answerIntent.asked) return;
    setAnswerIntent({ ...answerIntent, asked: true });
    voiceApi.ringHere(answerIntent.callSid).catch((err: unknown) => {
      setAnswerIntent(null);
      snackbar(err instanceof Error ? err.message : 'The call has ended');
    });
  }, [answerIntent, incoming, incomingParent, voice.registered, accept, snackbar]);

  useEffect(() => {
    if (!answerIntent) return;
    const timer = setTimeout(
      () => setAnswerIntent(null),
      Math.max(0, answerIntent.until - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [answerIntent]);

  // Call state: connected time, and a short "Call ended" when it finishes.
  const connected = voice.active && voice.connectionState === 'open';
  useEffect(() => {
    if (connected) {
      setActive((current) =>
        current && !current.connectedAt ? { ...current, connectedAt: Date.now() } : current,
      );
    }
  }, [connected]);
  useEffect(() => {
    // Speaker and earpiece only appear once the microphone is in use.
    if (voice.active) void refreshMicrophones();
  }, [voice.active, refreshMicrophones]);
  useEffect(() => {
    if (voice.active) {
      sawActive.current = true;
      return;
    }
    if (!active || !sawActive.current) return;
    sawActive.current = false;
    playEndTone();
    setEnded({ number: active.number, at: Date.now() });
    setActive(null);
    setMinimized(false);
    void queryClient.invalidateQueries({ queryKey: voiceKeys.calls });
    void queryClient.invalidateQueries({ queryKey: voiceKeys.unread });
  }, [voice.active, active, queryClient]);
  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(() => setEnded(null), 1500);
    return () => clearTimeout(timer);
  }, [ended]);

  const placeCall = useCallback(
    async (raw: string) => {
      const current = voiceRef.current;
      unlockAudio();
      const destination = normalizeDialablePhoneNumber(raw);
      if (!destination) {
        snackbar("That doesn't look like a phone number");
        return;
      }
      if (current.active || current.incoming) {
        snackbar("You're already on a call");
        return;
      }
      const from = boot?.numbers.find((n) => n.voice);
      if (!from) {
        snackbar('Your account has no number that can make calls');
        return;
      }
      if (current.micPermission !== 'granted') {
        const granted = await current.requestMicPermission();
        if (!granted) {
          snackbar('Allow the microphone to make calls');
          return;
        }
      }
      setDialer({ open: false, initial: '' });
      cancelled.current = false;
      setActive({
        number: destination,
        direction: 'outgoing',
        connectedAt: null,
        parentCallSid: null,
      });
      setMinimized(false);
      const call = await current.makeCall(from.id, destination, { recordCall: false });
      if (call && cancelled.current) {
        call.disconnect?.();
        return;
      }
      if (!call) {
        if (cancelled.current) return;
        setActive(null);
        // The hook reports why on its next state update.
        setTimeout(() => {
          const error = voiceRef.current.error ?? voiceRef.current.callNotice;
          snackbar(error ?? "Couldn't place the call. Try again.");
        }, 0);
      }
    },
    [boot, snackbar],
  );

  const value = useMemo<CallContextValue>(
    () => ({
      placeCall,
      openDialer: (initial = '') => setDialer({ open: true, initial }),
      onCall: Boolean(voice.active),
      registered: voice.registered,
    }),
    [placeCall, voice.active, voice.registered],
  );

  const activeName = active ? (lookup(active.number)?.name ?? null) : null;

  return (
    <CallContext.Provider value={value}>
      {children}
      {active && voice.active && minimized ? (
        <OngoingCallBar
          label={activeName ?? formatNumber(active.number)}
          connectedAt={active.connectedAt}
          onOpen={() => setMinimized(false)}
        />
      ) : null}
      {dialer.open ? (
        <Dialer
          initial={dialer.initial}
          fromNumber={boot?.numbers.find((n) => n.voice)?.e164 ?? null}
          onClose={() => setDialer({ open: false, initial: '' })}
          onCall={(number) => void placeCall(number)}
        />
      ) : null}
      {active && !minimized ? (
        <InCallScreen
          call={active}
          name={activeName}
          onMinimize={() => setMinimized(true)}
          onHangup={() => {
            if (voiceRef.current.active) {
              voiceRef.current.hangup();
            } else {
              // Still being set up: drop it as soon as it exists.
              cancelled.current = true;
              setActive(null);
            }
          }}
        />
      ) : null}
      {!voice.active && ended ? (
        <CallEndedScreen number={ended.number} name={lookup(ended.number)?.name ?? null} />
      ) : null}
      {incoming ? (
        <IncomingCallScreen
          from={incoming.from ?? ''}
          name={incomingName}
          answering={answering}
          micBlocked={voice.micPermission === 'denied'}
          onAnswer={() => void accept()}
          onDecline={decline}
        />
      ) : null}
    </CallContext.Provider>
  );
}

function callerLabel(from: string): string {
  return /\d/.test(from) ? formatNumber(from) : 'Unknown caller';
}

function IncomingCallScreen({
  from,
  name,
  answering,
  micBlocked,
  onAnswer,
  onDecline,
}: {
  from: string;
  name: string | null;
  answering: boolean;
  micBlocked: boolean;
  onAnswer: () => void;
  onDecline: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="voice-incoming-title"
      className="fixed inset-0 z-[70] flex flex-col bg-gradient-to-b from-[#174ea6] to-[#0b2a5c] text-white"
    >
      <div className="flex flex-1 flex-col items-center justify-center px-6 pt-[env(safe-area-inset-top)] text-center">
        <p className="text-sm uppercase tracking-[0.2em] text-white/70">Incoming call</p>
        <div className="relative mt-8">
          <span className="absolute inset-0 animate-ping rounded-full bg-white/20" />
          <Avatar name={name} seed={from} size="xl" />
        </div>
        <h1 id="voice-incoming-title" className="mt-8 break-words text-4xl font-normal">
          {name ?? callerLabel(from)}
        </h1>
        {name ? <p className="mt-2 text-lg text-white/80">{callerLabel(from)}</p> : null}
        <p className="mt-2 text-sm text-white/60">Voice call</p>
        {micBlocked ? (
          <p className="mt-6 max-w-xs rounded-lg bg-white/10 px-4 py-2 text-sm">
            The microphone is blocked. Allow it in the site settings to answer.
          </p>
        ) : null}
      </div>
      <div className="flex items-end justify-around px-10 pb-[calc(env(safe-area-inset-bottom)+3rem)]">
        <button
          type="button"
          onClick={onDecline}
          className="flex flex-col items-center gap-3 text-sm"
        >
          <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-gv-red shadow-lg active:scale-95">
            <Icon name="callEnd" className="h-9 w-9" />
          </span>
          Decline
        </button>
        <button
          type="button"
          onClick={onAnswer}
          disabled={answering || micBlocked}
          className="flex flex-col items-center gap-3 text-sm disabled:opacity-60"
        >
          <span className="flex h-[72px] w-[72px] animate-bounce items-center justify-center rounded-full bg-gv-green-bright shadow-lg active:scale-95">
            <Icon name="phone" className="h-9 w-9" />
          </span>
          {answering ? 'Answering…' : 'Answer'}
        </button>
      </div>
    </div>
  );
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function CallControl({
  icon,
  label,
  active,
  onClick,
  disabled,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className="flex flex-col items-center gap-2 text-sm text-gv-ink disabled:opacity-40"
    >
      <span
        className={`flex h-16 w-16 items-center justify-center rounded-full ${
          active ? 'bg-gv-blue text-white' : 'bg-gv-soft text-gv-ink'
        }`}
      >
        <Icon name={icon} className="h-7 w-7" />
      </span>
      {label}
    </button>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function InCallScreen({
  call,
  name,
  onMinimize,
  onHangup,
}: {
  call: ActiveCall;
  name: string | null;
  onMinimize: () => void;
  onHangup: () => void;
}) {
  const voice = useVoiceDevice();
  const prefs = useDevicePrefs();
  const [keypad, setKeypad] = useState(false);
  const [digits, setDigits] = useState('');
  const [speaker, setSpeaker] = useState(false);
  const now = useNow(Boolean(call.connectedAt));
  const recording = useBrowserRecordingStatus();
  const recordingNow =
    call.direction === 'incoming' &&
    recording?.direction === 'inbound' &&
    recording.state === 'recording';
  const speakerInput = voice.microphoneInputs.find((m) => /speaker/i.test(m.label));
  const earpieceInput = voice.microphoneInputs.find((m) => /earpiece/i.test(m.label));

  const status = call.connectedAt
    ? formatTimer((now - call.connectedAt) / 1000)
    : voice.connectionState === 'ringing'
      ? 'Ringing…'
      : call.direction === 'incoming'
        ? 'Connecting…'
        : 'Calling…';

  async function toggleSpeaker() {
    const next = !speaker;
    const ok = await voice.routeCallAudio(
      next ? (speakerInput?.deviceId ?? null) : (earpieceInput?.deviceId ?? null),
    );
    if (ok) setSpeaker(next);
  }

  function press(key: string) {
    // You hear your own key press even while the call's audio path carries it,
    // which is what a real handset does.
    playKeyTone(key);
    if (prefs.vibrate) vibrate(10);
    setDigits((d) => (d + key).slice(-24));
    voice.sendDigits(key);
  }

  // A physical keyboard drives the in-call keypad too, for menu systems. The
  // handler is held in a ref so call state changes don't re-subscribe.
  const pressRef = useRef(press);
  pressRef.current = press;
  useEffect(() => {
    if (!keypad) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^[0-9*#]$/.test(event.key)) return;
      event.preventDefault();
      pressRef.current(event.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keypad]);

  return (
    <div className="fixed inset-0 z-[65] flex flex-col bg-white pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      <div className="flex items-center justify-between px-2 py-2">
        <button
          type="button"
          onClick={onMinimize}
          aria-label="Back to the app"
          className="flex h-10 w-10 items-center justify-center rounded-full text-gv-muted hover:bg-gv-soft"
        >
          <Icon name="expandMore" />
        </button>
        <span className="text-sm text-gv-muted">Voice call</span>
        <span className="w-10" />
      </div>
      <div className="flex flex-col items-center px-6 pt-4 text-center">
        <Avatar name={name} seed={call.number} size="xl" />
        <h1 className="mt-5 break-words text-3xl text-gv-ink">
          {name ?? callerLabel(call.number)}
        </h1>
        {name ? <p className="mt-1 text-gv-muted">{formatNumber(call.number)}</p> : null}
        <p className={`mt-2 text-sm ${call.connectedAt ? 'text-gv-green' : 'text-gv-muted'}`}>
          {status}
          {recordingNow && <span className="text-gv-red"> · Recording</span>}
        </p>
        {voice.error ? <p className="mt-3 max-w-sm text-xs text-gv-red">{voice.error}</p> : null}
      </div>
      <div className="flex flex-1 flex-col justify-end px-6 pb-8">
        {keypad ? (
          <div className="mx-auto w-full max-w-xs">
            <p className="mb-3 h-8 text-center text-2xl tracking-widest text-gv-ink">{digits}</p>
            <div className="grid grid-cols-3 gap-3">
              {KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => press(key)}
                  className="flex h-16 flex-col items-center justify-center rounded-full text-2xl text-gv-ink hover:bg-gv-soft active:bg-gv-line"
                >
                  {key}
                  <span className="text-[10px] tracking-widest text-gv-muted">
                    {KEYPAD_LETTERS[key] ?? ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mx-auto mt-6 grid w-full max-w-xs grid-cols-3 gap-y-6">
          <CallControl
            icon={voice.isMuted ? 'micOff' : 'mic'}
            label={voice.isMuted ? 'Unmute' : 'Mute'}
            active={voice.isMuted}
            onClick={voice.toggleMute}
          />
          <CallControl
            icon="dialpad"
            label="Keypad"
            active={keypad}
            onClick={() => setKeypad((k) => !k)}
            disabled={!voice.canSendDigits}
          />
          <CallControl
            icon="speaker"
            label="Speaker"
            active={speaker}
            onClick={() => void toggleSpeaker()}
            disabled={!speakerInput}
          />
        </div>
        <button
          type="button"
          onClick={onHangup}
          aria-label="End call"
          className="mx-auto mt-8 flex h-[72px] w-[72px] items-center justify-center rounded-full bg-gv-red text-white shadow-lg active:scale-95"
        >
          <Icon name="callEnd" className="h-9 w-9" />
        </button>
      </div>
    </div>
  );
}

function CallEndedScreen({ number, name }: { number: string; name: string | null }) {
  return (
    <div className="fixed inset-0 z-[65] flex flex-col items-center justify-center bg-white text-center">
      <Avatar name={name} seed={number} size="xl" />
      <h1 className="mt-5 text-3xl text-gv-ink">{name ?? callerLabel(number)}</h1>
      <p className="mt-2 text-sm text-gv-red">Call ended</p>
    </div>
  );
}

function OngoingCallBar({
  label,
  connectedAt,
  onOpen,
}: {
  label: string;
  connectedAt: number | null;
  onOpen: () => void;
}) {
  const now = useNow(Boolean(connectedAt));
  return (
    <button
      type="button"
      onClick={onOpen}
      className="fixed inset-x-0 top-0 z-[55] flex items-center justify-center gap-2 bg-gv-green-bright px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-sm font-medium text-white shadow"
    >
      <Icon name="phone" className="h-4 w-4" />
      {label} · {connectedAt ? formatTimer((now - connectedAt) / 1000) : 'Calling…'} · Tap to return
    </button>
  );
}

export function Dialer({
  initial,
  fromNumber,
  onClose,
  onCall,
}: {
  initial: string;
  fromNumber: string | null;
  onClose: () => void;
  onCall: (number: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const { data: contacts } = useContacts();
  const matches = useMemo(() => searchContacts(contacts ?? [], value, 6), [contacts, value]);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);

  const add = useCallback((key: string) => {
    playKeyTone(key);
    setValue((v) => (v + key).slice(0, 32));
  }, []);
  const call = useCallback(() => {
    if (value.trim()) onCall(value);
  }, [onCall, value]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (/^[0-9*#+]$/.test(event.key)) add(event.key);
      else if (event.key === 'Backspace') setValue((v) => v.slice(0, -1));
      else if (event.key === 'Enter') call();
      else if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [add, call, onClose]);

  // Holding 0 types "+", like a phone keypad.
  const startHold = (key: string) => {
    held.current = false;
    if (key !== '0') return;
    holdTimer.current = setTimeout(() => {
      held.current = true;
      setValue((v) => (v + '+').slice(0, 32));
    }, 500);
  };
  const endHold = (key: string) => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (!held.current) add(key);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:inset-auto md:bottom-6 md:right-6 md:h-[640px] md:w-[380px] md:rounded-3xl md:shadow-2xl">
      <div className="flex items-center gap-2 px-2 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close keypad"
          className="flex h-10 w-10 items-center justify-center rounded-full text-gv-muted hover:bg-gv-soft"
        >
          <Icon name="back" />
        </button>
        <span className="text-base text-gv-ink">Make a call</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {matches.length > 0 ? (
          <ul className="border-b border-gv-line">
            {matches.map((contact) => {
              const phone = contact.phones[0];
              return (
                <li key={contact.id}>
                  <button
                    type="button"
                    onClick={() => phone && onCall(phone.e164)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-gv-soft"
                  >
                    <Avatar name={contact.name} seed={contact.id} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-gv-ink">{contact.name}</span>
                      <span className="block truncate text-xs text-gv-muted">
                        {phone ? formatNumber(phone.e164) : ''}
                        {phone?.label ? ` · ${phone.label}` : ''}
                      </span>
                    </span>
                    <Icon name="phone" className="h-5 w-5 text-gv-green" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <div className="px-6 pb-6">
        <div className="flex items-center gap-2 py-3">
          <input
            aria-label="Phone number"
            value={formatDialInput(value)}
            onChange={(event) => setValue(event.target.value.replace(/[^\d+*#]/g, ''))}
            inputMode="none"
            placeholder="Enter a name or number"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-center text-3xl text-gv-ink placeholder:text-base placeholder:text-gv-muted focus:ring-0"
          />
          {value ? (
            <button
              type="button"
              aria-label="Delete"
              onClick={() => setValue((v) => v.slice(0, -1))}
              onContextMenu={(event) => {
                event.preventDefault();
                setValue('');
              }}
              className="flex h-10 w-10 items-center justify-center rounded-full text-gv-muted hover:bg-gv-soft"
            >
              <Icon name="backspace" />
            </button>
          ) : null}
        </div>
        {fromNumber ? (
          <p className="mb-2 text-center text-xs text-gv-muted">
            Calling from {formatNumber(fromNumber)}
          </p>
        ) : null}
        <div className="mx-auto grid max-w-xs grid-cols-3 gap-2">
          {KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onPointerDown={() => startHold(key)}
              onPointerUp={() => endHold(key)}
              onPointerLeave={() => holdTimer.current && clearTimeout(holdTimer.current)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  add(key);
                }
              }}
              className="flex h-16 select-none flex-col items-center justify-center rounded-full text-[28px] leading-none text-gv-ink hover:bg-gv-soft active:bg-gv-line"
            >
              {key}
              <span className="mt-1 h-3 text-[10px] tracking-widest text-gv-muted">
                {KEYPAD_LETTERS[key] ?? ''}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={call}
          disabled={!value}
          aria-label="Call"
          className="mx-auto mt-4 flex h-16 w-16 items-center justify-center rounded-full bg-gv-green-bright text-white shadow-md hover:brightness-110 active:scale-95 disabled:opacity-40"
        >
          <Icon name="phone" className="h-8 w-8" />
        </button>
      </div>
    </div>
  );
}
