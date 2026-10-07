// Records a Twilio Voice SDK call inside the browser: the user's microphone on
// the left channel and the other party on the right, the same layout as
// Twilio's dual-channel recordings. Audio is Opus at ~32 kbps (about 240 KB a
// minute), delivered in chunks every few seconds so little is lost if the tab
// dies mid-call.

export interface RecordableCall {
  parameters?: Record<string, string | undefined>;
  status?: () => string;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  getLocalStream?: () => MediaStream | undefined;
  getRemoteStream?: () => MediaStream | undefined;
}

const CHUNK_MS = 5_000;
const REWIRE_MS = 1_000;
const BITS_PER_SECOND = 32_000;
// Chrome and Firefox record Opus in WebM or Ogg; Safari only offers MP4.
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** The recording format this browser supports, or null when it cannot record. */
export function recordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') return null;
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

interface Input {
  track: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
}

const LOCAL = 0;
const REMOTE = 1;

export class CallRecorder {
  private readonly context: AudioContext;
  private readonly merger: ChannelMergerNode;
  private readonly recorder: MediaRecorder;
  private readonly inputs: Array<Input | null> = [null, null];
  private readonly rewireTimer: ReturnType<typeof setInterval>;
  private remotePlayer: HTMLAudioElement | null = null;
  private seq = 0;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly call: RecordableCall,
    mimeType: string,
    onChunk: (seq: number, data: Blob) => void,
  ) {
    this.context = new AudioContext();
    const destination = this.context.createMediaStreamDestination();
    this.merger = this.context.createChannelMerger(2);
    this.merger.connect(destination);
    this.rewire();
    this.recorder = new MediaRecorder(destination.stream, {
      mimeType,
      audioBitsPerSecond: BITS_PER_SECOND,
    });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) onChunk(this.seq++, event.data);
    };
    this.recorder.start(CHUNK_MS);
    // A context created outside a click can start suspended, which records silence.
    void this.context.resume().catch(() => undefined);
    this.rewireTimer = setInterval(() => this.rewire(), REWIRE_MS);
  }

  /** Stops recording; resolves after the last chunk has been delivered. */
  stop(): Promise<void> {
    this.stopping ??= new Promise<void>((resolve) => {
      clearInterval(this.rewireTimer);
      const finish = () => {
        for (const input of this.inputs) input?.source.disconnect();
        if (this.remotePlayer) this.remotePlayer.srcObject = null;
        void this.context.close().catch(() => undefined);
        resolve();
      };
      if (this.recorder.state === 'inactive') {
        finish();
        return;
      }
      this.recorder.addEventListener('stop', finish, { once: true });
      try {
        this.recorder.stop();
      } catch {
        finish();
      }
    });
    return this.stopping;
  }

  // The SDK replaces the microphone track when the input changes (Android's
  // speakerphone and earpiece are separate inputs), and a track may not exist
  // yet when the call connects, so keep following the call's current tracks.
  private rewire(): void {
    this.attach(LOCAL, this.call.getLocalStream?.());
    this.attach(REMOTE, this.call.getRemoteStream?.());
  }

  private attach(channel: number, stream: MediaStream | undefined): void {
    const track = stream?.getAudioTracks().find((t) => t.readyState === 'live');
    const current = this.inputs[channel];
    if (!track || current?.track === track) return;
    current?.source.disconnect();
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    source.connect(this.merger, 0, channel);
    this.inputs[channel] = { track, source };
    if (channel === REMOTE) this.keepRemoteFlowing(track);
  }

  // Chrome only feeds a remote WebRTC track into Web Audio while a media
  // element is playing it. A muted element does that without doubling audio.
  private keepRemoteFlowing(track: MediaStreamTrack): void {
    this.remotePlayer ??= Object.assign(document.createElement('audio'), { muted: true });
    this.remotePlayer.srcObject = new MediaStream([track]);
    void this.remotePlayer.play().catch(() => undefined);
  }
}
