// Analyzes ~1024-sample frames (~21 ms at 48 kHz) of the whisper tab and
// reports to the main thread:
//   l, r  : RMS level of the left / right channel in the analysis band (~0.7-12 kHz)
//   bands : [[l, r], ...] RMS levels per sub-band (voice / mid / bright)
//   coh   : peak normalized L/R cross-correlation within +-1 ms (interaural delay).
//           High when one sound reaches both ears, low when each ear hears a
//           different sound (e.g. whispering on one side, ear cleaning on the other).
const FRAME = 1024;
const MAX_LAG_SEC = 0.001;
const BANDS = [
  [700, 2500],
  [2500, 6000],
  [6000, 12000]
];

// RBJ biquad, transposed direct form II.
function biquad(type, f, fs) {
  const w = (2 * Math.PI * Math.min(f, fs * 0.45)) / fs;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b1 = type === 'lp' ? 1 - cos : -(1 + cos);
  const b0 = b1 / (type === 'lp' ? 2 : -2);
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0 };
}

function run(q, x) {
  const y = q.b0 * x + q.z1;
  q.z1 = q.b1 * x - q.a1 * y + q.z2;
  q.z2 = q.b2 * x - q.a2 * y;
  return y;
}

class AsmrMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = new Float32Array(FRAME);
    this.R = new Float32Array(FRAME);
    this.n = 0;
    this.maxLag = Math.round(MAX_LAG_SEC * sampleRate);
    // Per band and channel: [highpass, lowpass]
    this.filters = BANDS.map(([lo, hi]) =>
      [0, 1].map(() => [biquad('hp', lo, sampleRate), biquad('lp', hi, sampleRate)])
    );
    this.bandE = BANDS.map(() => [0, 0]);
  }

  process(inputs) {
    const ch = inputs[0];
    const has = ch && ch.length;
    const inL = has ? ch[0] : null;
    const inR = has ? ch[1] || ch[0] : null;
    const len = has ? inL.length : 128;
    const { filters, bandE } = this;
    for (let i = 0; i < len; i++) {
      const xl = has ? inL[i] : 0;
      const xr = has ? inR[i] : 0;
      let sl = 0;
      let sr = 0;
      for (let b = 0; b < filters.length; b++) {
        const yl = run(filters[b][0][1], run(filters[b][0][0], xl));
        const yr = run(filters[b][1][1], run(filters[b][1][0], xr));
        bandE[b][0] += yl * yl;
        bandE[b][1] += yr * yr;
        sl += yl;
        sr += yr;
      }
      this.L[this.n] = sl;
      this.R[this.n] = sr;
      if (++this.n === FRAME) this.report();
    }
    return true;
  }

  report() {
    const { L, R, maxLag } = this;
    let el = 0;
    let er = 0;
    for (let i = 0; i < FRAME; i++) {
      el += L[i] * L[i];
      er += R[i] * R[i];
    }
    let best = 0;
    if (el > 0 && er > 0) {
      for (let k = -maxLag; k <= maxLag; k++) {
        let s = 0;
        const from = Math.max(0, -k);
        const to = FRAME - Math.max(0, k);
        for (let i = from; i < to; i++) s += L[i] * R[i + k];
        if (s > best) best = s;
      }
      best /= Math.sqrt(el * er);
    }
    this.port.postMessage({
      l: Math.sqrt(el / FRAME),
      r: Math.sqrt(er / FRAME),
      bands: this.bandE.map(([bl, br]) => [Math.sqrt(bl / FRAME), Math.sqrt(br / FRAME)]),
      coh: best,
      dt: FRAME / sampleRate
    });
    for (const e of this.bandE) e[0] = e[1] = 0;
    this.n = 0;
  }
}

registerProcessor('asmr-meter', AsmrMeter);
