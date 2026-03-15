/**
 * PCM Capture AudioWorklet Processor
 *
 * Captures microphone audio, converts Float32 samples to Int16 PCM,
 * and posts buffers to the main thread for streaming to the backend.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0][0]; // First input, first channel (mono)
    if (input && input.length > 0) {
      const int16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
