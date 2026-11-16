// Measures the RMS level of the left and right channels and reports them to
// the main thread roughly every 1024 samples (~21 ms at 48 kHz).
const REPORT_FRAMES = 1024;

class AsmrMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = 0;
    this.r = 0;
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const L = ch[0];
      const R = ch[1] || ch[0];
      for (let i = 0; i < L.length; i++) {
        this.l += L[i] * L[i];
        this.r += R[i] * R[i];
      }
      this.n += L.length;
    } else {
      this.n += 128;
    }
    if (this.n >= REPORT_FRAMES) {
      this.port.postMessage({
        l: Math.sqrt(this.l / this.n),
        r: Math.sqrt(this.r / this.n),
        dt: this.n / sampleRate
      });
      this.l = this.r = this.n = 0;
    }
    return true;
  }
}

registerProcessor('asmr-meter', AsmrMeter);
