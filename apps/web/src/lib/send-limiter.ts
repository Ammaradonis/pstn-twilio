// A Voice SDK AudioProcessor that runs the microphone through a peak limiter
// (public/audio/send-limiter.js) before it is sent, leaving headroom for encoding.
// A decoded recording's peaks do not establish where distortion originated:
// the limiter cannot undo input clipping or repair network/carrier impairments.
//
// It must never make the user silent: if the audio engine can't run (no user
// gesture yet, the worklet won't load), the microphone is sent unprocessed.

const WORKLET_URL = '/audio/send-limiter.js';
const RESUME_WAIT_MS = 300;
const LOAD_WAIT_MS = 1_000;

export const SEND_LIMITER_OPTIONS = {
  ceiling: 0.708, // -3 dBFS: headroom for the Opus and G.711 transcoding after it
  lookaheadMs: 5,
  attackMs: 1,
  releaseMs: 100,
};

interface Graph {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  limiter: AudioWorkletNode;
  destination: MediaStreamAudioDestinationNode;
}

export class SendLimiter {
  private readonly graphs = new Map<MediaStream, Graph>();

  async createProcessedStream(stream: MediaStream): Promise<MediaStream> {
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let limiter: AudioWorkletNode | undefined;
    let destination: MediaStreamAudioDestinationNode | undefined;
    try {
      // Each stream owns its context so replacing a microphone cannot close
      // the engine of a stream that is still being created.
      context = new AudioContext();
      if (context.state !== 'running') {
        // resume() can wait for a user gesture indefinitely; don't hold up the call.
        await within(context.resume(), RESUME_WAIT_MS);
      }
      if ((context.state as AudioContextState) !== 'running') throw new Error('Audio suspended');
      await within(context.audioWorklet.addModule(WORKLET_URL), LOAD_WAIT_MS);
      if ((context.state as AudioContextState) !== 'running') throw new Error('Audio suspended');
      source = context.createMediaStreamSource(stream);
      limiter = new AudioWorkletNode(context, 'send-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: SEND_LIMITER_OPTIONS,
      });
      destination = context.createMediaStreamDestination();
      destination.channelCount = 1;
      source.connect(limiter).connect(destination);
      const graph = { context, source, limiter, destination };
      limiter.onprocessorerror = () => {
        // An uncaught worklet error otherwise produces silence for the rest
        // of the call. Keep the same output track and bypass the failed node.
        graph.source.disconnect();
        graph.limiter.disconnect();
        graph.source.connect(graph.destination);
      };
      this.graphs.set(destination.stream, graph);
      return destination.stream;
    } catch {
      source?.disconnect();
      limiter?.disconnect();
      limiter?.port.close();
      destination?.stream.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => undefined);
      return stream;
    }
  }

  async destroyProcessedStream(stream: MediaStream): Promise<void> {
    const graph = this.graphs.get(stream);
    if (!graph) return;
    this.graphs.delete(stream);
    graph.limiter.onprocessorerror = null;
    graph.source.disconnect();
    graph.limiter.disconnect();
    graph.limiter.port.close();
    graph.destination.stream.getTracks().forEach((track) => track.stop());
    await graph.context.close().catch(() => undefined);
  }
}

async function within(operation: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Audio setup timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
