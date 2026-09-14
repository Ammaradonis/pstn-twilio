import type { CallQuality } from '../hooks/use-voice-device';

type Tone = 'good' | 'fair' | 'poor' | 'unknown';

// Twilio's network guidance for good call audio: round-trip time under 200 ms,
// jitter under 30 ms, packet loss under 3%, and a MOS of 4 or better.
function rttTone(ms: number | null): Tone {
  if (ms === null) return 'unknown';
  return ms > 400 ? 'poor' : ms > 200 ? 'fair' : 'good';
}
function jitterTone(ms: number | null): Tone {
  if (ms === null) return 'unknown';
  return ms > 30 ? 'poor' : ms > 15 ? 'fair' : 'good';
}
function lossTone(pct: number | null): Tone {
  if (pct === null) return 'unknown';
  return pct > 3 ? 'poor' : pct > 1 ? 'fair' : 'good';
}
function mosTone(mos: number | null): Tone {
  if (mos === null) return 'unknown';
  return mos < 3.5 ? 'poor' : mos < 4 ? 'fair' : 'good';
}

const TONE_STYLES: Record<Tone, string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  fair: 'border-amber-200 bg-amber-50 text-amber-800',
  poor: 'border-rose-200 bg-rose-50 text-rose-800',
  unknown: 'border-slate-200 bg-slate-50 text-slate-500',
};

const WARNING_MESSAGES: Record<string, string> = {
  'high-rtt':
    'High latency: the other person hears you late, so you may talk over each other. Close large uploads or streams, or move closer to your Wi-Fi.',
  'high-jitter':
    'Unstable connection: audio may sound robotic or break up. A wired connection helps.',
  'high-packet-loss': 'Packets are being lost: audio will break up. A wired connection helps.',
  'high-packets-lost-fraction':
    'Sustained packet loss: audio will break up. A wired connection helps.',
  'low-mos': 'Poor call quality on this connection.',
  'constant-audio-input-level':
    'No sound is coming from your microphone. Check the selected microphone and that it is not muted.',
  'low-bytes-sent': 'Your audio stopped sending. Check your connection.',
  'low-bytes-received': "The other side's audio stopped arriving. Check your connection.",
  'ice-connectivity-lost': 'The media connection dropped. Reconnecting…',
};

function Metric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <span
      className={`inline-flex items-baseline gap-1 rounded border px-2 py-0.5 text-xs ${TONE_STYLES[tone]}`}
    >
      <span className="text-[10px] uppercase tracking-wide opacity-75">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </span>
  );
}

function format(value: number | null, digits: number, unit: string): string {
  return value === null ? '—' : `${value.toFixed(digits)}${unit}`;
}

export function CallQualityPanel({
  quality,
  warnings,
}: {
  quality: CallQuality | null;
  warnings: string[];
}) {
  const messages = [...new Set(warnings.map((w) => WARNING_MESSAGES[w]).filter(Boolean))];

  return (
    <div className="mt-3 rounded border border-slate-200 p-3" aria-label="Call quality">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-slate-600">Connection</span>
        <Metric
          label="Latency"
          value={format(quality?.rttMs ?? null, 0, ' ms')}
          tone={rttTone(quality?.rttMs ?? null)}
        />
        <Metric
          label="Jitter"
          value={format(quality?.jitterMs ?? null, 0, ' ms')}
          tone={jitterTone(quality?.jitterMs ?? null)}
        />
        <Metric
          label="Loss"
          value={format(quality?.packetLossPct ?? null, 1, '%')}
          tone={lossTone(quality?.packetLossPct ?? null)}
        />
        <Metric
          label="MOS"
          value={format(quality?.mos ?? null, 1, '')}
          tone={mosTone(quality?.mos ?? null)}
        />
        {quality?.codec && (
          <span className="text-[11px] uppercase tracking-wide text-slate-500">
            {quality.codec}
          </span>
        )}
      </div>
      {messages.length > 0 && (
        <ul className="mt-2 space-y-1" role="alert">
          {messages.map((message) => (
            <li key={message} className="text-xs text-rose-700">
              {message}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-slate-500">
        On speakers? Headphones stop the other person hearing an echo of their own voice.
      </p>
    </div>
  );
}
