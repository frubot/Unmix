const FALLBACK_FAV =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#4a5160"/></svg>'
  );

const $tabs = document.getElementById('tabs');
const $empty = document.getElementById('empty');
const $toggle = document.getElementById('showall');
const $asmr = document.getElementById('asmr');
const $asmrbar = document.getElementById('asmrbar');
const $depth = document.getElementById('depth');

// Shared with offscreen.js (same extension origin), which reads depth on startup.
const ASMR_KEY = 'unmix.asmr';
const asmrCfg = { on: false, depth: 1 };
try {
  Object.assign(asmrCfg, JSON.parse(localStorage.getItem(ASMR_KEY)) || {});
} catch (e) {}
// tabId -> fn(pan) for follower rows whose pan is driven by the whisper tab
let liveRows = new Map();

let showAll = false;
let state = { captured: {} };
const starting = new Set();
let activeSlider = null;
let refreshPending = false;

const send = (msg) => chrome.runtime.sendMessage({ ...msg, target: 'sw' });

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

function panLabel(p) {
  if (p <= -0.99) return 'L';
  if (p >= 0.99) return 'R';
  if (Math.abs(p) < 0.02) return 'C';
  return (p < 0 ? 'L' : 'R') + Math.round(Math.abs(p) * 100);
}

async function refresh() {
  if (activeSlider) {
    refreshPending = true;
    return;
  }
  const res = await send({ type: 'get-state' }).catch(() => null);
  state = res && res.captured ? res : { captured: {} };
  if (Object.values(state.captured).some((c) => c.role && c.role !== 'none')) asmrCfg.on = true;

  const [audible, active, all] = await Promise.all([
    chrome.tabs.query({ audible: true }),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.tabs.query({})
  ]);
  const activeId = active[0] && active[0].id;
  const byId = new Map(all.map((t) => [t.id, t]));
  const seen = new Set();
  const rows = [];

  for (const id of Object.keys(state.captured).map(Number)) {
    const t = byId.get(id);
    if (t) { rows.push(t); seen.add(id); }
  }
  for (const t of audible) {
    if (!seen.has(t.id)) { rows.push(t); seen.add(t.id); }
  }
  if (active[0] && !seen.has(active[0].id)) { rows.push(active[0]); seen.add(active[0].id); }
  rows.sort((a, b) => (b.id === activeId) - (a.id === activeId));

  const others = showAll ? all.filter((t) => !seen.has(t.id) && !t.discarded) : [];
  render(rows, others, activeId);
}

function render(rows, others, activeId) {
  $tabs.textContent = '';
  const all = [...rows, ...others];
  $empty.hidden = all.length > 0;
  liveRows = new Map();
  renderAsmrBar();
  for (const t of all) $tabs.appendChild(rowEl(t, t.id === activeId, others.includes(t)));
  $toggle.textContent = showAll ? '他のタブを隠す ▴' : '他のタブも表示 ▾';
}

function rowEl(t, isActive, isOther) {
  const cap = state.captured[t.id];
  const pan = cap ? cap.pan : 0;
  const vol = cap ? cap.volume : 1;
  const role = (cap && cap.role) || 'none';
  const following = role === 'follow';
  const dis = following ? ' disabled' : '';
  // Capture requires the extension to be invoked while the tab is active,
  // so uncaptured background tabs can only navigate to the tab first.
  const gotoTab = !cap && !isActive;

  const row = document.createElement('div');
  row.className = 'row' + (cap ? ' on' : '') + (isActive ? ' this' : '') + (isOther ? ' other' : '') + (gotoTab ? ' goto' : '');
  row.innerHTML = `
    <img class="fav" src="${esc(t.favIconUrl || FALLBACK_FAV)}" alt="">
    <div class="main">
      <div class="title" title="${esc(t.title || '')}">${esc(t.title || '(no title)')}</div>
      ${gotoTab ? '<div class="go">クリックでこのタブへ移動 →</div>' : `
      <div class="ctl">
        <button data-p="-1" title="左耳のみ"${dis}>L</button>
        <input class="pan" type="range" min="-1" max="1" step="0.01" value="${pan}"${dis}>
        <button data-p="0" title="中央"${dis}>C</button>
        <button data-p="1" title="右耳のみ"${dis}>R</button>
        <span class="panval">${panLabel(pan)}</span>
      </div>
      <div class="ctl">
        <span class="lbl">vol</span>
        <input class="vol" type="range" min="0" max="2" step="0.01" value="${vol}">
        <span class="volval">${Math.round(vol * 100)}%</span>
        <span class="live"></span>
      </div>
      ${asmrCfg.on ? `
      <div class="ctl">
        <button data-role="whisper" title="このタブの囁きの位置を検出する">囁き</button>
        <button data-role="follow" title="囁きの位置に合わせて左右に動かす">追従</button>
      </div>` : ''}`}
      <div class="err"></div>
    </div>`;

  const panInput = row.querySelector('.pan');
  const panVal = row.querySelector('.panval');
  const volInput = row.querySelector('.vol');
  const volVal = row.querySelector('.volval');
  const live = row.querySelector('.live');
  const err = row.querySelector('.err');
  const presets = [...row.querySelectorAll('button[data-p]')];
  const roleBtns = [...row.querySelectorAll('button[data-role]')];

  const markPresets = (p) =>
    presets.forEach((b) => b.classList.toggle('sel', +b.dataset.p === (Math.abs(p) < 0.02 ? 0 : p <= -0.99 ? -1 : p >= 0.99 ? 1 : NaN)));
  markPresets(pan);

  const showLive = () => {
    if (activeSlider === volInput) {
      volInput.addEventListener('change', showLive, { once: true });
      return;
    }
    if (!live.querySelector('.rel')) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'capture中';
      const rel = document.createElement('button');
      rel.className = 'rel';
      rel.textContent = '解除';
      rel.addEventListener('click', async () => {
        await send({ type: 'stop', tabId: t.id }).catch(() => {});
        delete state.captured[t.id];
        refresh();
      });
      live.append(badge, rel);
    }
    row.classList.add('on');
  };
  if (cap) showLive();

  if (gotoTab) {
    row.addEventListener('click', async () => {
      err.textContent = '';
      try {
        if (t.windowId != null) {
          await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        }
        await chrome.tabs.update(t.id, { active: true });
      } catch (e) {
        err.textContent = 'そのタブはもう存在しません。';
        refresh();
      }
    });
    return row;
  }

  const ensureStarted = async () => {
    if (state.captured[t.id]) return true;
    if (starting.has(t.id)) return false;
    starting.add(t.id);
    err.textContent = '';
    const res = await send({
      type: 'start', tabId: t.id,
      pan: +panInput.value, volume: +volInput.value
    }).catch((e) => ({ error: String(e) }));
    starting.delete(t.id);
    if (!res || res.error) {
      err.textContent =
        'キャプチャ開始に失敗。そのタブをアクティブにして拡張機能アイコンをクリックしてから試してください。' +
        (res && res.error ? ` (${res.error})` : '');
      return false;
    }
    state.captured[t.id] = { pan: +panInput.value, volume: +volInput.value };
    showLive();
    return true;
  };

  panInput.addEventListener('input', async () => {
    const p = +panInput.value;
    panVal.textContent = panLabel(p);
    markPresets(p);
    if (await ensureStarted()) {
      state.captured[t.id].pan = p;
      send({ type: 'set', tabId: t.id, pan: p }).catch(() => {});
    }
  });

  volInput.addEventListener('input', async () => {
    const v = +volInput.value;
    volVal.textContent = Math.round(v * 100) + '%';
    if (await ensureStarted()) {
      state.captured[t.id].volume = v;
      send({ type: 'set', tabId: t.id, volume: v }).catch(() => {});
    }
  });

  presets.forEach((b) =>
    b.addEventListener('click', () => {
      panInput.value = b.dataset.p;
      panInput.dispatchEvent(new Event('input'));
    })
  );

  roleBtns.forEach((b) => {
    b.classList.toggle('sel', b.dataset.role === role);
    b.addEventListener('click', async () => {
      const next = b.dataset.role === role ? 'none' : b.dataset.role;
      if (!(await ensureStarted())) return;
      const res = await send({ type: 'set', tabId: t.id, role: next }).catch((e) => ({ error: String(e) }));
      if (res && res.error) {
        err.textContent = '設定に失敗しました。 (' + res.error + ')';
        return;
      }
      refresh();
    });
  });

  if (following) {
    liveRows.set(t.id, (v) => {
      panInput.value = v;
      panVal.textContent = panLabel(v);
      markPresets(v);
    });
  }

  return row;
}

function renderAsmrBar() {
  $asmr.classList.toggle('sel', asmrCfg.on);
  $asmrbar.hidden = !asmrCfg.on;
  $depth.value = asmrCfg.depth;
}

function saveAsmr() {
  try { localStorage.setItem(ASMR_KEY, JSON.stringify(asmrCfg)); } catch (e) {}
}

function pushAsmr() {
  saveAsmr();
  send({ type: 'asmr-config', depth: asmrCfg.depth }).catch(() => {});
}

$asmr.addEventListener('click', async () => {
  asmrCfg.on = !asmrCfg.on;
  saveAsmr();
  if (!asmrCfg.on) {
    await Promise.all(
      Object.entries(state.captured)
        .filter(([, c]) => c.role && c.role !== 'none')
        .map(([id]) => send({ type: 'set', tabId: +id, role: 'none' }).catch(() => {}))
    );
  }
  refresh();
});

$depth.addEventListener('input', () => {
  asmrCfg.depth = +$depth.value;
  pushAsmr();
});

setInterval(async () => {
  if (!liveRows.size) return;
  const res = await send({ type: 'live' }).catch(() => null);
  if (!res || !res.pans) return;
  for (const [id, v] of Object.entries(res.pans)) {
    const update = liveRows.get(+id);
    if (update && typeof v === 'number') update(v);
  }
}, 100);

$toggle.addEventListener('click', () => {
  showAll = !showAll;
  refresh();
});

document.addEventListener('pointerdown', (e) => {
  if (e.target.matches('input[type=range]')) activeSlider = e.target;
});
const endSliderDrag = () => {
  activeSlider = null;
  if (refreshPending) {
    refreshPending = false;
    refresh();
  }
};
document.addEventListener('pointerup', endSliderDrag);
document.addEventListener('pointercancel', endSliderDrag);

// Stream ended while popup is open -> reflect released state.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'sw' && msg.type === 'ended') refresh();
});

let rt;
chrome.tabs.onUpdated.addListener((id, ci) => {
  if ('audible' in ci || 'mutedInfo' in ci || 'title' in ci) {
    clearTimeout(rt);
    rt = setTimeout(refresh, 150);
  }
});
chrome.tabs.onRemoved.addListener(() => refresh());

refresh();
