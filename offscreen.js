// tabId -> { tabId, ctx, stream, source, panner, gain, pan, volume }
const pipelines = new Map();

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
        set(msg);
        return { ok: true };
      case 'remove':
        await remove(Number(msg.tabId));
        return { ok: true };
      case 'list':
        return {
          tabs: [...pipelines.values()].map((p) => ({ tabId: p.tabId, pan: p.pan, volume: p.volume }))
        };
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
  const panner = ctx.createStereoPanner();
  const gain = ctx.createGain();
  panner.pan.value = pan;
  gain.gain.value = volume;
  source.connect(panner);
  panner.connect(gain);
  gain.connect(ctx.destination);

  const p = { tabId, ctx, stream, source, panner, gain, pan, volume };
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

function set({ tabId, pan, volume }) {
  const p = pipelines.get(Number(tabId));
  if (!p) return;
  const t = p.ctx.currentTime;
  if (pan != null) {
    p.pan = pan;
    p.panner.pan.setTargetAtTime(pan, t, 0.02);
  }
  if (volume != null) {
    p.volume = volume;
    p.gain.gain.setTargetAtTime(volume, t, 0.02);
  }
}

function teardown(p) {
  pipelines.delete(p.tabId);
  try { p.source.disconnect(); } catch (e) {}
  try { p.panner.disconnect(); } catch (e) {}
  try { p.gain.disconnect(); } catch (e) {}
  p.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
  p.ctx.close().catch(() => {});
}

async function remove(tabId) {
  const p = pipelines.get(tabId);
  if (p) teardown(p);
}
