// tabId -> { tabId, ctx, stream, source, eq, panner, gain, pan, volume, role, livePan, liveEq, meter }
// role: 'none' | 'whisper' (ASMR source being analyzed) | 'follow' (pan driven by the whisper)
const pipelines = new Map();

// --- ASMR mode -------------------------------------------------------------
// The whisper tab's left/right level difference is measured in the speech
// band and mapped to a position (-1 = left .. 1 = right). Follower tabs are
// panned to the opposite side.
// When each ear seems to hear a different sound (e.g. whispering on one side
// and ear cleaning on the other), followers are centered instead, and their
// EQ is cut in the bands where the whisper tab is loud so the two don't mask
// each other.
const ASMR_KEY = 'unmix.asmr';
const FULL_SCALE_DB = 12; // L/R level difference treated as fully one-sided
const ABS_GATE = 3e-4; // ~-70 dBFS: below this the whisper is treated as silent
const REL_GATE = 0.15; // ~-16 dB below the recent peak: pauses / background hiss
const PEAK_DECAY = 3; // seconds
const POS_SMOOTH = 0.08; // seconds
const PAN_GLIDE = 0.1; // seconds
// "Both sides active" detection. Either of:
//  - each ear hears a different sound (low L/R coherence while both are loud)
//  - sub-bands lean to opposite sides (e.g. voice band left, bright scratching right)
const COH_TWO = 0.7;
const SIDE_DB = 6; // level difference counted as clearly one-sided
const BAND_GATE = 0.1; // sub-band ignored below this fraction of the recent peak
const TWO_SMOOTH = 0.3; // seconds
const TWO_ON = 0.3; // share of recent frames showing both sides
const BOTH_HOLD = 1.5; // seconds to stay centered after both sides were active
// Follower EQ while centered: one peaking filter per meter sub-band
// (asmr-meter.js BANDS). Cut depth follows the whisper's long-term spectrum.
const EQ_BANDS = [
  { f: 1300, q: 0.75 },
  { f: 3900, q: 1.1 },
  { f: 8500, q: 1.4 }
];
const EQ_RANGE_DB = 18; // bands this far below the loudest whisper band get no cut
const EQ_AVG = 1.5; // seconds: smoothing of the whisper spectrum
const EQ_GLIDE = 0.25; // seconds

const asmr = {
  depth: 1, eq: 6, pos: 0, peak: 0,
  twoFrac: 0, bothHold: 0,
  bandAvg: EQ_BANDS.map(() => 0)
};
try {
  applyAsmrConfig(JSON.parse(localStorage.getItem(ASMR_KEY)) || {});
} catch (e) {}

// Chrome closes AUDIO_PLAYBACK offscreen docs after ~30s of silence, which would
// drop captures of paused or not-yet-audible tabs. Emit an inaudible 20 kHz
// tone so the document always counts as playing audio.
const keepAliveCtx = new AudioContext();
{
  const osc = keepAliveCtx.createOscillator();
  const g = keepAliveCtx.createGain();
  osc.frequency.value = 20000;
  g.gain.value = 0.01;
  osc.connect(g);
  g.connect(keepAliveCtx.destination);
  osc.start();
}
keepAliveCtx.resume().catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  (async () => {
    switch (msg.type) {
      case 'ping':
        return 'pong';
      case 'add':
        return await add(msg);
      case 'set':
        await set(msg);
        return { ok: true };
      case 'remove':
        await remove(Number(msg.tabId));
        return { ok: true };
      case 'asmr-config':
        applyAsmrConfig(msg);
        applyFollowers();
        return { ok: true };
      case 'list':
        return {
          tabs: [...pipelines.values()].map((p) => ({
            tabId: p.tabId, pan: p.pan, volume: p.volume, role: p.role
          }))
        };
      case 'live': {
        const pans = {};
        for (const p of pipelines.values()) if (p.role === 'follow') pans[p.tabId] = p.livePan;
        return { pans };
      }
    }
  })()
    .then((res) => sendResponse(res === undefined ? { ok: true } : res))
    .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});

async function add({ tabId, streamId, pan = 0, volume = 1 }) {
  tabId = Number(tabId);
  await remove(tabId);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});

  const source = ctx.createMediaStreamSource(stream);
  const eq = EQ_BANDS.map(({ f, q }) =>
    new BiquadFilterNode(ctx, { type: 'peaking', frequency: f, Q: q, gain: 0 })
  );
  const panner = ctx.createStereoPanner();
  const gain = ctx.createGain();
  panner.pan.value = pan;
  gain.gain.value = volume;
  source.connect(eq[0]);
  for (let i = 1; i < eq.length; i++) eq[i - 1].connect(eq[i]);
  eq[eq.length - 1].connect(panner);
  panner.connect(gain);
  gain.connect(ctx.destination);

  const p = {
    tabId, ctx, stream, source, eq, panner, gain, pan, volume,
    role: 'none', livePan: pan, liveEq: eq.map(() => 0), meter: null, workletLoaded: null
  };
  pipelines.set(tabId, p);

  const track = stream.getAudioTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      if (pipelines.get(tabId) !== p) return;
      teardown(p);
      chrome.runtime.sendMessage({ target: 'sw', type: 'ended', tabId }).catch(() => {});
    });
  }
  return { ok: true };
}

async function set({ tabId, pan, volume, role }) {
  const p = pipelines.get(Number(tabId));
  if (!p) return;
  const t = p.ctx.currentTime;
  if (pan != null) {
    p.pan = pan;
    if (p.role !== 'follow') glidePan(p, pan, 0.02);
  }
  if (volume != null) {
    p.volume = volume;
    p.gain.gain.setTargetAtTime(volume, t, 0.02);
  }
  if (role != null) await setRole(p, role);
}

function glidePan(p, v, tau) {
  p.livePan = v;
  p.panner.pan.setTargetAtTime(v, p.ctx.currentTime, tau);
}

function glideEq(p, gains, tau) {
  gains.forEach((g, i) => {
    if (Math.abs(g - p.liveEq[i]) < 0.1) return;
    p.liveEq[i] = g;
    p.eq[i].gain.setTargetAtTime(g, p.ctx.currentTime, tau);
  });
}

async function setRole(p, role) {
  if (!['none', 'whisper', 'follow'].includes(role) || p.role === role) return;
  const prev = p.role;
  p.role = role;
  if (prev === 'whisper') detachMeter(p);
  if (prev === 'follow') {
    glidePan(p, p.pan, 0.05);
    glideEq(p, p.eq.map(() => 0), EQ_GLIDE);
  }
  if (role === 'whisper') {
    // Only one whisper source at a time.
    for (const o of pipelines.values()) {
      if (o !== p && o.role === 'whisper') {
        o.role = 'none';
        detachMeter(o);
      }
    }
    asmr.pos = 0;
    asmr.peak = 0;
    asmr.twoFrac = 0;
    asmr.bothHold = 0;
    asmr.bandAvg.fill(0);
    try {
      await attachMeter(p);
    } catch (e) {
      if (p.role === 'whisper') p.role = 'none';
      throw e;
    }
  }
  applyFollowers();
}

async function attachMeter(p) {
  const { ctx } = p;
  if (!p.workletLoaded) p.workletLoaded = ctx.audioWorklet.addModule('asmr-meter.js');
  try {
    await p.workletLoaded;
  } catch (e) {
    p.workletLoaded = null;
    throw e;
  }
  if (p.role !== 'whisper' || p.meter || pipelines.get(p.tabId) !== p) return;

  // Analyze the original (pre-pan) signal.
  const node = new AudioWorkletNode(ctx, 'asmr-meter', {
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  });
  // The meter outputs silence; connecting it keeps the graph pulling it.
  const mute = new GainNode(ctx, { gain: 0 });
  node.port.onmessage = (e) => onMeter(p, e.data);
  p.source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  p.meter = { node, mute };
}

function detachMeter(p) {
  const m = p.meter;
  if (!m) return;
  p.meter = null;
  m.node.port.onmessage = null;
  try { p.source.disconnect(m.node); } catch (e) {}
  for (const n of [m.node, m.mute]) {
    try { n.disconnect(); } catch (e) {}
  }
  applyFollowers();
}

const levelDb = (l, r) => 20 * Math.log10((r + 1e-12) / (l + 1e-12));

function onMeter(p, { l, r, bands, coh, dt }) {
  if (p.role !== 'whisper' || !p.meter) return;
  const lvl = Math.max(l, r);
  asmr.peak = Math.max(lvl, asmr.peak * Math.exp(-dt / PEAK_DECAY));
  asmr.bothHold = Math.max(0, asmr.bothHold - dt);
  // Hold the last position through pauses between phrases.
  if (lvl < ABS_GATE || lvl < asmr.peak * REL_GATE) return;

  const k = 1 - Math.exp(-dt / EQ_AVG);
  bands.forEach(([bl, br], i) => {
    asmr.bandAvg[i] += (Math.hypot(bl, br) - asmr.bandAvg[i]) * k;
  });

  let bandL = false;
  let bandR = false;
  for (const [bl, br] of bands) {
    if (Math.max(bl, br) < asmr.peak * BAND_GATE) continue;
    const d = levelDb(bl, br);
    if (d > SIDE_DB) bandR = true;
    if (d < -SIDE_DB) bandL = true;
  }
  const both =
    (bandL && bandR) ||
    (Math.min(l, r) >= asmr.peak * REL_GATE && coh < COH_TWO);
  asmr.twoFrac += ((both ? 1 : 0) - asmr.twoFrac) * (1 - Math.exp(-dt / TWO_SMOOTH));
  if (asmr.twoFrac > TWO_ON) asmr.bothHold = BOTH_HOLD;

  const target = asmr.bothHold > 0 ? 0 : Math.max(-1, Math.min(1, levelDb(l, r) / FULL_SCALE_DB));
  asmr.pos += (target - asmr.pos) * (1 - Math.exp(-dt / POS_SMOOTH));
  applyFollowers();
}

function hasWhisper() {
  for (const p of pipelines.values()) if (p.role === 'whisper' && p.meter) return true;
  return false;
}

// Cut (dB, <= 0) per EQ band: deepest where the whisper is loudest.
function eqCuts() {
  const top = Math.max(...asmr.bandAvg);
  return asmr.bandAvg.map((a) => {
    if (!(top > 0) || asmr.eq <= 0) return 0;
    const rel = 20 * Math.log10((a + 1e-12) / top); // <= 0
    return -asmr.eq * Math.max(0, 1 + rel / EQ_RANGE_DB);
  });
}

function applyFollowers() {
  const active = hasWhisper();
  const v = -asmr.pos * asmr.depth;
  const flat = EQ_BANDS.map(() => 0);
  const cuts = active && asmr.bothHold > 0 ? eqCuts() : flat;
  for (const p of pipelines.values()) {
    if (p.role !== 'follow') continue;
    const target = active ? v : p.pan;
    if (Math.abs(target - p.livePan) > 0.002) glidePan(p, target, PAN_GLIDE);
    glideEq(p, cuts, EQ_GLIDE);
  }
}

function applyAsmrConfig({ depth, eq }) {
  if (typeof depth === 'number' && isFinite(depth)) asmr.depth = Math.max(0, Math.min(1, depth));
  if (typeof eq === 'number' && isFinite(eq)) asmr.eq = Math.max(0, Math.min(12, eq));
}

function teardown(p) {
  pipelines.delete(p.tabId);
  detachMeter(p);
  try { p.source.disconnect(); } catch (e) {}
  for (const n of p.eq) {
    try { n.disconnect(); } catch (e) {}
  }
  try { p.panner.disconnect(); } catch (e) {}
  try { p.gain.disconnect(); } catch (e) {}
  p.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
  p.ctx.close().catch(() => {});
}

async function remove(tabId) {
  const p = pipelines.get(tabId);
  if (p) teardown(p);
}
