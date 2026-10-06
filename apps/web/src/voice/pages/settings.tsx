import {
  VOICE_FORWARDING_LIMIT,
  VOICE_GREETING_MAX_MS,
  normalizeDialablePhoneNumber,
  type ForwardingNumberDto,
  type VoiceSettingsDto,
} from '@pstn-twilio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { api } from '../../lib/api-client';
import { useAuthStore } from '../../lib/auth-store';
import { Icon, type IconName } from '../components/icons';
import {
  IconButton,
  PageLoading,
  PrimaryButton,
  Sheet,
  Spinner,
  Switch,
  TextButton,
  errorMessage,
  useSnackbar,
} from '../components/ui';
import { useBlocking } from '../hooks/use-voice-actions';
import {
  invalidateKinds,
  useBootstrap,
  useContactLookup,
  useDevices,
  useForwarding,
  useSettings,
  voiceKeys,
} from '../hooks/use-voice-data';
import { deviceId, isIos, isStandaloneApp, setDevicePrefs, useDevicePrefs } from '../lib/device';
import { deviceTimeZone, formatLastSeen, formatNumber, formatTimer } from '../lib/format';
import {
  startGreetingRecording,
  type GreetingRecorder,
  type RecordedGreeting,
} from '../lib/greeting';
import { promptInstall, useCanInstall } from '../lib/install';
import {
  currentPushState,
  disablePush,
  enablePush,
  pushSupported,
  type PushState,
} from '../lib/push';
import { RINGTONES, startRingtone, unlockAudio, type RingtoneId } from '../lib/ringtone';
import { voiceApi } from '../lib/voice-api';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      className="mx-3 mb-4 scroll-mt-20 rounded-2xl border border-gv-line bg-white md:mx-4"
    >
      <h2 className="px-5 pb-1 pt-4 text-base font-medium text-gv-ink">{title}</h2>
      <div className="pb-2">{children}</div>
    </section>
  );
}

function Row({
  icon,
  title,
  description,
  control,
  onClick,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      {icon ? <Icon name={icon} className="mt-0.5 h-5 w-5 shrink-0 text-gv-muted" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] text-gv-ink">{title}</span>
        {description ? (
          <span className="mt-0.5 block text-sm text-gv-muted">{description}</span>
        ) : null}
      </span>
    </>
  );
  return (
    <div className="flex items-start gap-4 px-5 py-3">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex min-w-0 flex-1 items-start gap-4 text-left"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-4">{body}</div>
      )}
      {control ? <div className="shrink-0 self-center">{control}</div> : null}
    </div>
  );
}

function useSettingsMutation() {
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  return async (patch: Partial<Omit<VoiceSettingsDto, 'recordedGreeting'>>) => {
    const previous = queryClient.getQueryData<VoiceSettingsDto>(voiceKeys.settings);
    if (previous) queryClient.setQueryData(voiceKeys.settings, { ...previous, ...patch });
    try {
      const next = await voiceApi.updateSettings(patch);
      queryClient.setQueryData(voiceKeys.settings, next);
    } catch (err) {
      if (previous) queryClient.setQueryData(voiceKeys.settings, previous);
      snackbar(errorMessage(err));
    }
  };
}

export function SettingsPage() {
  const { data: settings, isLoading } = useSettings();
  useEffect(() => {
    if (!settings || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [settings]);
  if (isLoading || !settings) return <PageLoading />;
  return (
    <div className="pb-6 pt-2">
      <h1 className="px-5 pb-3 text-2xl text-gv-ink">Settings</h1>
      <AccountSection />
      <LinkedNumbersSection />
      <CallsSection settings={settings} />
      <VoicemailSection settings={settings} />
      <ThisDeviceSection />
      <BlockedSection />
      <DevicesSection />
    </div>
  );
}

function AccountSection() {
  const { data: boot } = useBootstrap();
  const { user, logout } = useAuthStore();
  const [password, setPassword] = useState(false);
  const zone = deviceTimeZone();
  return (
    <Section id="account" title="Account">
      {boot?.numbers.map((number) => (
        <Row
          key={number.id}
          icon="phone"
          title={formatNumber(number.e164)}
          description={`Your Voice number · ${[number.voice ? 'calls' : null, number.sms ? 'texts' : null].filter(Boolean).join(' and ')}`}
        />
      ))}
      <Row icon="person" title={user?.email ?? ''} description="Signed in" />
      <Row
        icon="globe"
        title={zone.replace(/_/g, ' ')}
        description="Times in your call history and messages follow this device's time zone"
      />
      <Row icon="edit" title="Change password" onClick={() => setPassword(true)} />
      <Row icon="logout" title="Sign out of this device" onClick={() => logout()} />
      <ChangePasswordSheet open={password} onClose={() => setPassword(false)} />
    </Section>
  );
}

function ChangePasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const snackbar = useSnackbar();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const mismatch = form.confirm !== '' && form.next !== form.confirm;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mismatch || form.next.length < 8) return;
    setSaving(true);
    try {
      await api.auth.changePassword(form.current, form.next);
      snackbar('Password changed');
      setForm({ current: '', next: '', confirm: '' });
      onClose();
    } catch (err) {
      snackbar(
        errorMessage(err) === 'Unauthorized' ? 'The current password is wrong' : errorMessage(err),
      );
    } finally {
      setSaving(false);
    }
  }
  const field =
    'w-full rounded-lg border border-gv-line px-3 py-3 text-[15px] focus:border-gv-blue focus:ring-1 focus:ring-gv-blue';
  return (
    <Sheet open={open} onClose={onClose} title="Change password">
      <form onSubmit={(event) => void submit(event)} className="space-y-3 px-6 pb-6">
        <input
          className={field}
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          value={form.current}
          onChange={(e) => setForm({ ...form, current: e.target.value })}
        />
        <input
          className={field}
          type="password"
          autoComplete="new-password"
          placeholder="New password (8+ characters)"
          value={form.next}
          onChange={(e) => setForm({ ...form, next: e.target.value })}
        />
        <input
          className={field}
          type="password"
          autoComplete="new-password"
          placeholder="Confirm new password"
          value={form.confirm}
          onChange={(e) => setForm({ ...form, confirm: e.target.value })}
        />
        {mismatch ? (
          <p className="text-xs text-gv-red">The new passwords don&apos;t match</p>
        ) : null}
        <div className="flex justify-end">
          <PrimaryButton
            type="submit"
            disabled={saving || !form.current || form.next.length < 8 || mismatch}
          >
            {saving ? 'Saving…' : 'Change password'}
          </PrimaryButton>
        </div>
      </form>
    </Sheet>
  );
}

function forwardingStatus(row: ForwardingNumberDto): string {
  if (row.verified) return row.enabled ? 'Rings for your calls' : 'Turned off';
  if (row.verifyStatus === 'calling') return 'Calling to verify…';
  if (row.verifyStatus === 'wrong-code') return "The code didn't match. Verify again.";
  if (row.verifyStatus === 'failed') return "Verification call wasn't completed";
  return 'Not verified';
}

function LinkedNumbersSection() {
  const { data: rows = [] } = useForwarding();
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<{ id: string; code: string } | null>(null);

  async function verify(id: string) {
    try {
      const result = await voiceApi.verifyForwarding(id);
      setVerifying({ id, code: result.code });
      invalidateKinds(queryClient, ['forwarding']);
    } catch (err) {
      snackbar(errorMessage(err));
    }
  }
  async function toggle(row: ForwardingNumberDto, enabled: boolean) {
    try {
      await voiceApi.updateForwarding(row.id, { enabled });
      invalidateKinds(queryClient, ['forwarding']);
    } catch (err) {
      snackbar(errorMessage(err));
    }
  }
  async function remove(row: ForwardingNumberDto) {
    try {
      await voiceApi.removeForwarding(row.id);
      invalidateKinds(queryClient, ['forwarding']);
      snackbar(`${row.label} removed`);
    } catch (err) {
      snackbar(errorMessage(err));
    }
  }

  return (
    <Section id="linked" title="Linked numbers">
      <p className="px-5 pb-2 text-sm text-gv-muted">
        Calls to your Voice number also ring these phones, at the same time as this app. Link up to{' '}
        {VOICE_FORWARDING_LIMIT} personal or desk phones.
      </p>
      {rows.map((row) => (
        <Row
          key={row.id}
          icon="forwarded"
          title={
            <>
              {row.label} <span className="text-gv-muted">· {formatNumber(row.e164)}</span>
            </>
          }
          description={
            <span
              className={
                row.verifyStatus === 'failed' || row.verifyStatus === 'wrong-code'
                  ? 'text-gv-red'
                  : ''
              }
            >
              {forwardingStatus(row)}
            </span>
          }
          control={
            <span className="flex items-center gap-1">
              {row.verified ? (
                <Switch
                  checked={row.enabled}
                  label={`Ring ${row.label}`}
                  onChange={(next) => void toggle(row, next)}
                />
              ) : (
                <TextButton
                  onClick={() => void verify(row.id)}
                  disabled={row.verifyStatus === 'calling'}
                >
                  Verify
                </TextButton>
              )}
              <IconButton
                icon="delete"
                label={`Remove ${row.label}`}
                onClick={() => void remove(row)}
              />
            </span>
          }
        />
      ))}
      {rows.length < VOICE_FORWARDING_LIMIT ? (
        <div className="px-3 pt-1">
          <TextButton onClick={() => setAdding(true)}>
            <span className="flex items-center gap-2">
              <Icon name="add" className="h-5 w-5" /> New linked number
            </span>
          </TextButton>
        </div>
      ) : (
        <p className="px-5 pt-1 text-sm text-gv-muted">
          You&apos;ve linked the most phones allowed.
        </p>
      )}
      <AddLinkedNumberSheet
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(row) => {
          setAdding(false);
          void verify(row.id);
        }}
      />
      <VerifySheet
        verifying={verifying}
        rows={rows}
        onClose={() => setVerifying(null)}
        onRetry={(id) => void verify(id)}
      />
    </Section>
  );
}

function AddLinkedNumberSheet({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (row: ForwardingNumberDto) => void;
}) {
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('Mobile');
  const [saving, setSaving] = useState(false);
  const valid = Boolean(normalizeDialablePhoneNumber(number));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      const row = await voiceApi.addForwarding(number, label.trim() || 'Phone');
      invalidateKinds(queryClient, ['forwarding']);
      setNumber('');
      onAdded(row);
    } catch (err) {
      snackbar(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  const field =
    'w-full rounded-lg border border-gv-line px-3 py-3 text-[15px] focus:border-gv-blue focus:ring-1 focus:ring-gv-blue';
  return (
    <Sheet open={open} onClose={onClose} title="Link a phone">
      <form onSubmit={(event) => void submit(event)} className="space-y-3 px-6 pb-6">
        <p className="text-sm text-gv-muted">
          We&apos;ll call this phone and ask you to enter a 2-digit code to confirm it&apos;s yours.
        </p>
        <input
          className={field}
          inputMode="tel"
          autoFocus
          placeholder="Phone number"
          aria-label="Phone number"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {['Mobile', 'Home', 'Work', 'Desk'].map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setLabel(option)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${label === option ? 'border-gv-blue bg-gv-blue-soft text-gv-blue' : 'border-gv-line text-gv-ink'}`}
            >
              {option}
            </button>
          ))}
        </div>
        <input
          className={field}
          placeholder="Name for this phone"
          aria-label="Name for this phone"
          maxLength={40}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <TextButton onClick={onClose}>Cancel</TextButton>
          <PrimaryButton type="submit" disabled={!valid || saving}>
            {saving ? 'Adding…' : 'Verify'}
          </PrimaryButton>
        </div>
      </form>
    </Sheet>
  );
}

function VerifySheet({
  verifying,
  rows,
  onClose,
  onRetry,
}: {
  verifying: { id: string; code: string } | null;
  rows: ForwardingNumberDto[];
  onClose: () => void;
  onRetry: (id: string) => void;
}) {
  const row = rows.find((r) => r.id === verifying?.id);
  return (
    <Sheet
      open={Boolean(verifying && row)}
      onClose={onClose}
      title={row?.verified ? 'Phone linked' : 'Verify your phone'}
    >
      {row ? (
        <div className="px-6 pb-6 text-center">
          {row.verified ? (
            <>
              <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#e6f4ea] text-gv-green">
                <Icon name="check" className="h-9 w-9" />
              </span>
              <p className="mt-4 text-gv-ink">
                {row.label} will ring when someone calls your Voice number.
              </p>
              <div className="mt-6 flex justify-center">
                <PrimaryButton onClick={onClose}>Done</PrimaryButton>
              </div>
            </>
          ) : row.verifyStatus === 'calling' ? (
            <>
              <p className="text-sm text-gv-muted">
                We&apos;re calling {formatNumber(row.e164)}. When asked, enter this code:
              </p>
              <p className="my-5 text-6xl font-light tracking-[0.3em] text-gv-ink">
                {verifying?.code}
              </p>
              <p className="flex items-center justify-center gap-2 text-sm text-gv-muted">
                <Spinner className="h-4 w-4" /> Waiting for the code…
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-gv-red">{forwardingStatus(row)}</p>
              <div className="mt-6 flex justify-center gap-2">
                <TextButton onClick={onClose}>Close</TextButton>
                <PrimaryButton onClick={() => onRetry(row.id)}>Call me again</PrimaryButton>
              </div>
            </>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}

function dndUntilLabel(iso: string | null): string {
  if (!iso) return 'On until you turn it off';
  return `On until ${new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function CallsSection({ settings }: { settings: VoiceSettingsDto }) {
  const update = useSettingsMutation();
  const [dnd, setDnd] = useState(false);
  const tomorrow8 = () => {
    const d = new Date();
    d.setDate(d.getDate() + (d.getHours() >= 8 ? 1 : 0));
    d.setHours(8, 0, 0, 0);
    return d.toISOString();
  };
  return (
    <Section id="calls" title="Calls">
      <Row
        icon="dnd"
        title="Do not disturb"
        description={
          settings.doNotDisturb
            ? `${dndUntilLabel(settings.doNotDisturbUntil)}. Calls go straight to voicemail.`
            : 'Send all calls to voicemail and silence notifications'
        }
        control={
          <Switch
            checked={settings.doNotDisturb}
            label="Do not disturb"
            onChange={(next) =>
              next ? setDnd(true) : void update({ doNotDisturb: false, doNotDisturbUntil: null })
            }
          />
        }
      />
      <Row
        icon="smartphone"
        title="Ring my devices"
        description="Incoming calls ring this app on every device you're signed in on"
        control={
          <Switch
            checked={settings.ringDevices}
            label="Ring my devices"
            onChange={(next) => void update({ ringDevices: next })}
          />
        }
      />
      <Row
        icon="forwarded"
        title="Screen calls on linked phones"
        description="Hear who's calling and press 1 to answer, so your phone's own voicemail can't take the call"
        control={
          <Switch
            checked={settings.screenCalls}
            label="Screen calls"
            onChange={(next) => void update({ screenCalls: next })}
          />
        }
      />
      <Row
        icon="refresh"
        title="Ring for"
        description="Before the caller goes to voicemail"
        control={
          <select
            aria-label="Ring for"
            value={settings.ringSeconds}
            onChange={(e) => void update({ ringSeconds: Number(e.target.value) })}
            className="rounded-lg border border-gv-line py-2 text-sm"
          >
            {[15, 20, 25, 30, 40].map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        }
      />
      <Sheet open={dnd} onClose={() => setDnd(false)} title="Do not disturb">
        <div className="pb-4">
          {[
            { label: 'For 1 hour', until: () => new Date(Date.now() + 60 * 60_000).toISOString() },
            { label: 'Until 8 AM', until: tomorrow8 },
            { label: 'Until I turn it off', until: () => null },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => {
                setDnd(false);
                void update({ doNotDisturb: true, doNotDisturbUntil: option.until() });
              }}
              className="block w-full px-6 py-3 text-left text-[15px] text-gv-ink hover:bg-gv-soft"
            >
              {option.label}
            </button>
          ))}
        </div>
      </Sheet>
    </Section>
  );
}

function VoicemailSection({ settings }: { settings: VoiceSettingsDto }) {
  const update = useSettingsMutation();
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const [text, setText] = useState(settings.greetingText ?? '');
  const [recorder, setRecorder] = useState<GreetingRecorder | null>(null);
  const [recordStart, setRecordStart] = useState<number | null>(null);
  const [recorded, setRecorded] = useState<RecordedGreeting | null>(null);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(Date.now());
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => setText(settings.greetingText ?? ''), [settings.greetingText]);
  useEffect(() => {
    if (!recordStart) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [recordStart]);

  async function record() {
    try {
      const next = await startGreetingRecording(VOICE_GREETING_MAX_MS);
      setRecorded(null);
      setRecorder(next);
      setRecordStart(Date.now());
      setNow(Date.now());
    } catch (err) {
      snackbar(`Couldn't use the microphone: ${errorMessage(err)}`);
    }
  }
  async function stop() {
    if (!recorder) return;
    try {
      setRecorded(await recorder.stop());
    } catch (err) {
      snackbar(errorMessage(err));
    } finally {
      setRecorder(null);
      setRecordStart(null);
    }
  }
  async function saveRecording() {
    if (!recorded) return;
    setSaving(true);
    try {
      const next = await voiceApi.saveGreeting(recorded.wavBase64, recorded.durationMs);
      queryClient.setQueryData(voiceKeys.settings, next);
      setRecorded(null);
      snackbar('Greeting saved');
    } catch (err) {
      snackbar(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  async function playSaved() {
    try {
      const blob = await voiceApi.greetingAudio();
      audio.current?.pause();
      audio.current = new Audio(URL.createObjectURL(blob));
      await audio.current.play();
    } catch (err) {
      snackbar(errorMessage(err));
    }
  }
  async function deleteSaved() {
    try {
      queryClient.setQueryData(voiceKeys.settings, await voiceApi.deleteGreeting());
    } catch (err) {
      snackbar(errorMessage(err));
    }
  }

  const choice = (mode: VoiceSettingsDto['greetingMode'], label: string, disabled = false) => (
    <label
      className={`flex items-center gap-3 px-5 py-2 text-[15px] ${disabled ? 'opacity-50' : ''}`}
    >
      <input
        type="radio"
        name="greeting"
        checked={settings.greetingMode === mode}
        disabled={disabled}
        onChange={() => void update({ greetingMode: mode })}
        className="text-gv-blue focus:ring-gv-blue"
      />
      {label}
    </label>
  );

  return (
    <Section id="voicemail" title="Voicemail">
      <Row
        icon="voicemail"
        title="Voicemail"
        description="Callers you don't answer can leave a message"
        control={
          <Switch
            checked={settings.voicemailEnabled}
            label="Voicemail"
            onChange={(next) => void update({ voicemailEnabled: next })}
          />
        }
      />
      {settings.voicemailEnabled ? (
        <>
          <Row
            icon="message"
            title="Transcribe voicemail"
            description="Read voicemail as text, in the language the caller speaks"
            control={
              <Switch
                checked={settings.voicemailTranscribe}
                label="Transcribe voicemail"
                onChange={(next) => void update({ voicemailTranscribe: next })}
              />
            }
          />
          <p className="px-5 pb-1 pt-3 text-sm font-medium text-gv-ink">Greeting</p>
          {choice('default', 'Standard greeting')}
          {choice('text', 'Read my text aloud')}
          {settings.greetingMode === 'text' ? (
            <div className="px-5 pb-2 pl-12">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="Hi, you've reached Sam. Leave a message and I'll call you back."
                className="w-full rounded-lg border border-gv-line px-3 py-2 text-sm"
              />
              <div className="flex justify-end">
                <TextButton
                  onClick={() => void update({ greetingText: text })}
                  disabled={text === (settings.greetingText ?? '')}
                >
                  Save text
                </TextButton>
              </div>
            </div>
          ) : null}
          {choice('recorded', 'My recorded greeting', !settings.recordedGreeting)}
          <div className="space-y-2 px-5 pb-3 pl-12 pt-1">
            {settings.recordedGreeting ? (
              <div className="flex items-center gap-1 text-sm text-gv-muted">
                Saved greeting · {formatTimer(settings.recordedGreeting.durationMs / 1000)}
                <IconButton icon="play" label="Play greeting" onClick={() => void playSaved()} />
                <IconButton
                  icon="delete"
                  label="Delete greeting"
                  onClick={() => void deleteSaved()}
                />
              </div>
            ) : null}
            {recorder ? (
              <div className="flex items-center gap-3">
                <span className="h-3 w-3 animate-pulse rounded-full bg-gv-red" />
                <span className="text-sm tabular-nums text-gv-ink">
                  Recording {formatTimer((now - (recordStart ?? now)) / 1000)} /{' '}
                  {formatTimer(VOICE_GREETING_MAX_MS / 1000)}
                </span>
                <PrimaryButton onClick={() => void stop()}>Stop</PrimaryButton>
              </div>
            ) : recorded ? (
              <div className="space-y-2">
                <audio controls src={recorded.previewUrl} className="w-full" />
                <div className="flex gap-2">
                  <PrimaryButton onClick={() => void saveRecording()} disabled={saving}>
                    {saving ? 'Saving…' : 'Use this greeting'}
                  </PrimaryButton>
                  <TextButton onClick={() => setRecorded(null)}>Discard</TextButton>
                </div>
              </div>
            ) : (
              <TextButton onClick={() => void record()}>
                <span className="flex items-center gap-2">
                  <Icon name="mic" className="h-5 w-5" />
                  {settings.recordedGreeting ? 'Record a new greeting' : 'Record a greeting'}
                </span>
              </TextButton>
            )}
          </div>
        </>
      ) : null}
    </Section>
  );
}

function ThisDeviceSection() {
  const prefs = useDevicePrefs();
  const { data: boot } = useBootstrap();
  const snackbar = useSnackbar();
  const queryClient = useQueryClient();
  const canInstall = useCanInstall();
  const [push, setPush] = useState<PushState>(() => currentPushState());
  const [busy, setBusy] = useState(false);
  const stopPreview = useRef<(() => void) | null>(null);
  useEffect(() => () => stopPreview.current?.(), []);
  const telHandlerSupported =
    typeof navigator !== 'undefined' && 'registerProtocolHandler' in navigator;

  async function turnOnNotifications() {
    if (!boot?.pushPublicKey) {
      snackbar('Notifications are not set up on the server yet');
      return;
    }
    setBusy(true);
    try {
      const state = await enablePush(boot.pushPublicKey, deviceId());
      setPush(state);
      invalidateKinds(queryClient, ['devices']);
      if (state === 'denied')
        snackbar('Notifications are blocked. Allow them in the browser’s site settings.');
    } finally {
      setBusy(false);
    }
  }
  async function turnOffNotifications() {
    setBusy(true);
    try {
      await disablePush(deviceId());
      setPush('default');
      invalidateKinds(queryClient, ['devices']);
    } catch (err) {
      snackbar(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  function preview(id: RingtoneId) {
    stopPreview.current?.();
    unlockAudio();
    stopPreview.current = startRingtone(id, { once: true });
  }

  const pushDescription: Record<PushState, string> = {
    unsupported: "This browser can't show notifications.",
    'needs-install':
      'On iPhone, tap Share → Add to Home Screen, open Voice from there, then turn on notifications.',
    default: 'Get calls, voicemail and texts even when the app is closed',
    denied: 'Blocked in the browser. Allow notifications in the site settings, then come back.',
    granted: 'Calls, voicemail and texts show up even when the app is closed',
  };

  return (
    <Section id="device" title="Notifications & sound on this device">
      <Row
        icon="bell"
        title="Notifications"
        description={pushDescription[push]}
        control={
          push === 'granted' ? (
            <TextButton onClick={() => void turnOffNotifications()} disabled={busy}>
              Turn off
            </TextButton>
          ) : push === 'default' && pushSupported() ? (
            <PrimaryButton onClick={() => void turnOnNotifications()} disabled={busy}>
              Turn on
            </PrimaryButton>
          ) : null
        }
      />
      <Row
        icon="music"
        title="Ringtone"
        control={
          <select
            aria-label="Ringtone"
            value={prefs.ringtone}
            onChange={(e) => {
              const id = e.target.value as RingtoneId;
              setDevicePrefs({ ringtone: id });
              preview(id);
            }}
            className="rounded-lg border border-gv-line py-2 text-sm"
          >
            {RINGTONES.map((tone) => (
              <option key={tone.id} value={tone.id}>
                {tone.label}
              </option>
            ))}
          </select>
        }
      />
      <Row
        icon="smartphone"
        title="Vibrate when ringing"
        control={
          <Switch
            checked={prefs.vibrate}
            label="Vibrate"
            onChange={(next) => setDevicePrefs({ vibrate: next })}
          />
        }
      />
      <Row
        icon="bell"
        title="Ring notification in the background"
        description="When the app is open but not on screen, show the call as a notification"
        control={
          <Switch
            checked={prefs.callNotifications}
            label="Ring notification"
            onChange={(next) => setDevicePrefs({ callNotifications: next })}
          />
        }
      />
      {telHandlerSupported ? (
        <Row
          icon="link"
          title="Open phone links with Voice"
          description="Clicking a phone number on a web page calls it from your Voice number"
          control={
            <TextButton
              onClick={() => {
                try {
                  navigator.registerProtocolHandler(
                    'tel',
                    `${window.location.origin}/voice/calls?dial=%s`,
                  );
                  snackbar('Confirm in the browser prompt');
                } catch (err) {
                  snackbar(errorMessage(err));
                }
              }}
            >
              Set up
            </TextButton>
          }
        />
      ) : null}
      {canInstall ? (
        <Row
          icon="download"
          title="Install the app"
          description="Open Voice from your home screen like any other app"
          control={<PrimaryButton onClick={() => void promptInstall()}>Install</PrimaryButton>}
        />
      ) : !isStandaloneApp() && isIos() ? (
        <Row
          icon="download"
          title="Install the app"
          description="Tap Share, then Add to Home Screen."
        />
      ) : null}
    </Section>
  );
}

function BlockedSection() {
  const { blocked, block, unblock } = useBlocking();
  const lookup = useContactLookup();
  const [number, setNumber] = useState('');
  const valid = normalizeDialablePhoneNumber(number);
  return (
    <Section id="blocked" title="Blocked numbers">
      <p className="px-5 pb-2 text-sm text-gv-muted">
        Blocked callers hear that your number isn&apos;t in service. Their texts are hidden and
        don&apos;t notify you.
      </p>
      {[...blocked].map((e164) => (
        <Row
          key={e164}
          icon="block"
          title={lookup(e164)?.name ?? formatNumber(e164)}
          description={lookup(e164) ? formatNumber(e164) : undefined}
          control={<TextButton onClick={() => void unblock(e164)}>Unblock</TextButton>}
        />
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          void block(valid);
          setNumber('');
        }}
        className="flex items-center gap-2 px-5 pb-2 pt-1"
      >
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          inputMode="tel"
          placeholder="Block a number"
          aria-label="Number to block"
          className="min-w-0 flex-1 rounded-lg border border-gv-line px-3 py-2 text-sm"
        />
        <TextButton
          danger
          onClick={() => valid && (void block(valid), setNumber(''))}
          disabled={!valid}
        >
          Block
        </TextButton>
      </form>
    </Section>
  );
}

function DevicesSection() {
  const { data: devices = [] } = useDevices();
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const current = deviceId();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!renaming || !name.trim()) return;
    try {
      await voiceApi.renameDevice(renaming, name.trim());
      invalidateKinds(queryClient, ['devices']);
      setRenaming(null);
    } catch (err) {
      snackbar(errorMessage(err));
    }
  }
  async function remove(id: string) {
    try {
      await voiceApi.removeDevice(id);
      invalidateKinds(queryClient, ['devices']);
    } catch (err) {
      snackbar(errorMessage(err));
    }
  }

  return (
    <Section id="devices" title="Your devices">
      <p className="px-5 pb-2 text-sm text-gv-muted">
        Messages, call history, voicemail and contacts stay in sync on all of them, and calls ring
        everywhere at once.
      </p>
      {devices.map((device) => (
        <Row
          key={device.id}
          icon="smartphone"
          title={
            <>
              {device.name}
              {device.id === current ? (
                <span className="ml-2 text-xs font-medium text-gv-blue">This device</span>
              ) : null}
            </>
          }
          description={[
            formatLastSeen(device.lastSeenAt),
            device.notifications ? 'Notifications on' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          control={
            <span className="flex items-center">
              <IconButton
                icon="edit"
                label={`Rename ${device.name}`}
                onClick={() => {
                  setRenaming(device.id);
                  setName(device.name);
                }}
              />
              {device.id !== current ? (
                <IconButton
                  icon="delete"
                  label={`Remove ${device.name}`}
                  onClick={() => void remove(device.id)}
                />
              ) : null}
            </span>
          }
        />
      ))}
      <Sheet open={Boolean(renaming)} onClose={() => setRenaming(null)} title="Rename device">
        <form onSubmit={(event) => void rename(event)} className="space-y-3 px-6 pb-6">
          <input
            autoFocus
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            aria-label="Device name"
            className="w-full rounded-lg border border-gv-line px-3 py-3 text-[15px]"
          />
          <div className="flex justify-end gap-2">
            <TextButton onClick={() => setRenaming(null)}>Cancel</TextButton>
            <PrimaryButton type="submit" disabled={!name.trim()}>
              Save
            </PrimaryButton>
          </div>
        </form>
      </Sheet>
    </Section>
  );
}
