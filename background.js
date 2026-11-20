const OFFSCREEN_URL = 'offscreen.html';

// tabId -> { pan, volume, role, wasMuted }
const captured = new Map();
let creatingOffscreen = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'sw') return;
  handle(msg)
    .then((res) => sendResponse(res === undefined ? { ok: true } : res))
    .catch((err) => sendResponse({ error: String((err && err.message) || err) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'get-state': {
      await syncFromOffscreen();
      return {
        captured: Object.fromEntries(
          [...captured].map(([id, v]) => [id, { pan: v.pan, volume: v.volume, role: v.role }])
        )
      };
    }
    case 'start':
      await startCapture(msg.tabId, msg.pan, msg.volume);
      return { ok: true };
    case 'set':
      await setParams(msg.tabId, msg.pan, msg.volume, msg.role);
      return { ok: true };
    case 'asmr-config':
      if (await chrome.offscreen.hasDocument()) {
        await sendToOffscreen({ type: 'asmr-config', depth: msg.depth }).catch(() => {});
      }
      return { ok: true };
    case 'live':
      if (!(await chrome.offscreen.hasDocument())) return { pans: {} };
      return (await sendToOffscreen({ type: 'live' }).catch(() => null)) || { pans: {} };
    case 'stop':
      await stopCapture(msg.tabId);
      return { ok: true };
    case 'ended':
      // The captured stream ended (tab closed, navigation, etc.)
      await sendToOffscreen({ type: 'remove', tabId: Number(msg.tabId) }).catch(() => {});
      await releaseTab(Number(msg.tabId));
      return { ok: true };
  }
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

async function waitForOffscreen() {
  for (let i = 0; i < 50; i++) {
    const res = await sendToOffscreen({ type: 'ping' }).catch(() => undefined);
    if (res === 'pong') return;
    await sleep(100);
  }
  throw new Error('offscreen document not responding');
}

async function ensureOffscreen() {
  while (creatingOffscreen) await creatingOffscreen;
  if (!(await chrome.offscreen.hasDocument())) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab audio and play it back with per-tab left/right panning'
    });
    try {
      await creatingOffscreen;
    } finally {
      creatingOffscreen = null;
    }
  }
  await waitForOffscreen();
}

async function startCapture(tabId, pan = 0, volume = 1) {
  tabId = Number(tabId);
  if (captured.has(tabId)) {
    await setParams(tabId, pan, volume);
    return;
  }
  const tab = await chrome.tabs.get(tabId);
  const wasMuted = !!(tab.mutedInfo && tab.mutedInfo.muted);

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const res = await sendToOffscreen({ type: 'add', tabId, streamId, pan, volume });
  if (!res || res.error) throw new Error((res && res.error) || 'offscreen add failed');

  if (!wasMuted) {
    try { await chrome.tabs.update(tabId, { muted: true }); } catch (e) {}
  }
  captured.set(tabId, { pan, volume, role: 'none', wasMuted });
}

async function setParams(tabId, pan, volume, role) {
  const e = captured.get(Number(tabId));
  if (!e) return;
  if (pan != null) e.pan = pan;
  if (volume != null) e.volume = volume;
  // Role is forwarded only when explicitly changed: the offscreen document
  // reassigns roles itself (e.g. only one whisper source), so `e.role` may be stale.
  const res = await sendToOffscreen({
    type: 'set', tabId: Number(tabId), pan: e.pan, volume: e.volume, role: role ?? undefined
  }).catch(() => null);
  if (res && res.error) throw new Error(res.error);
  if (role != null) e.role = role;
}

async function stopCapture(tabId) {
  tabId = Number(tabId);
  await sendToOffscreen({ type: 'remove', tabId }).catch(() => {});
  await releaseTab(tabId);
}

async function releaseTab(tabId) {
  const entry = captured.get(tabId);
  captured.delete(tabId);
  if (entry && !entry.wasMuted) {
    try { await chrome.tabs.update(tabId, { muted: false }); } catch (e) {}
  }
  // `captured` is in-memory and lost on service worker restarts, so the
  // offscreen document (which actually owns the pipelines) decides whether
  // it can be closed.
  if ((await remainingPipelines()) === 0) {
    try { await chrome.offscreen.closeDocument(); } catch (e) {}
    captured.clear();
    await unmuteLeftovers();
  }
}

async function remainingPipelines() {
  if (!(await chrome.offscreen.hasDocument())) return 0;
  const res = await sendToOffscreen({ type: 'list' }).catch(() => null);
  // If the doc exists but won't answer, don't close it — it may still hold
  // live captures. Chrome reaps silent AUDIO_PLAYBACK docs on its own.
  return res && Array.isArray(res.tabs) ? res.tabs.length : 1;
}

async function syncFromOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) {
    captured.clear();
  } else {
    const res = await sendToOffscreen({ type: 'list' }).catch(() => null);
    if (res && Array.isArray(res.tabs)) {
      const live = new Set(res.tabs.map((t) => t.tabId));
      for (const id of [...captured.keys()]) {
        if (!live.has(id)) captured.delete(id);
      }
      for (const t of res.tabs) {
        const prev = captured.get(t.tabId) || {};
        captured.set(t.tabId, { pan: t.pan, volume: t.volume, role: t.role || 'none', wasMuted: prev.wasMuted ?? false });
      }
    }
  }
  await unmuteLeftovers();
}

// Unmute tabs we muted but are no longer capturing (SW/offscreen restart leftovers).
async function unmuteLeftovers() {
  try {
    const all = await chrome.tabs.query({});
    for (const t of all) {
      if (
        t.mutedInfo && t.mutedInfo.muted &&
        t.mutedInfo.extensionId === chrome.runtime.id &&
        !captured.has(t.id)
      ) {
        chrome.tabs.update(t.id, { muted: false }).catch(() => {});
      }
    }
  } catch (e) {}
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (captured.has(tabId)) stopCapture(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A captured tab that gets unmuted externally = user wants normal audio back.
  if (changeInfo.mutedInfo && changeInfo.mutedInfo.muted === false && captured.has(tabId)) {
    stopCapture(tabId).catch(() => {});
  }
});

// The service worker may have restarted with an empty `captured` map while
// captures are still live in the offscreen document — rebuild state from it.
syncFromOffscreen().catch(() => {});
