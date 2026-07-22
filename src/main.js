import './style.css';
import { extractFrames, formatBytes, formatDuration } from './frames.js';
import { LOOP_LIMITS, mergeVideos } from './merge.js';

/** @typedef {{
 *   id: string,
 *   file: File,
 *   name: string,
 *   size: number,
 *   firstFrame: string | null,
 *   lastFrame: string | null,
 *   duration: number | null,
 *   width: number | null,
 *   height: number | null,
 *   status: 'loading' | 'ready' | 'error',
 *   error: string | null,
 * }} Clip */

/** @type {Clip[]} */
let clips = [];
let merging = false;
/** @type {string | null} */
let resultUrl = null;

const app = document.querySelector('#app');

app.innerHTML = `
  <header class="site-header">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M4 6h7v12H4V6zm9 0h7v12h-7V6z"/>
          <path d="M11 10.5l3.5 1.5-3.5 1.5v-3z" fill="oklch(0.12 0 0)"/>
        </svg>
      </div>
      <div class="brand-text">
        <h1>VideoMerge</h1>
        <p>首尾幀預覽 · 多段合併</p>
      </div>
    </div>
    <div class="header-meta" id="header-meta">本機處理 · 不上傳伺服器</div>
  </header>

  <main class="main">
    <section class="panel" aria-labelledby="upload-title">
      <div class="panel-head">
        <h2 id="upload-title">加入影片</h2>
        <p class="hint">支援 MP4、WebM、MOV 等瀏覽器可播放格式</p>
      </div>

      <label class="dropzone" id="dropzone" for="file-input">
        <input
          id="file-input"
          type="file"
          accept="video/*"
          multiple
          aria-label="選擇影片檔案"
        />
        <div class="dropzone-inner">
          <div class="dropzone-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 16V4M12 4l-4 4M12 4l4 4"/>
              <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>
            </svg>
          </div>
          <strong>拖曳影片到這裡，或點擊選擇</strong>
          <span>可一次加入多個檔案；合併順序可在下方調整</span>
        </div>
      </label>

      <div class="toolbar">
        <button type="button" class="btn btn-ghost" id="btn-add-more">再加入影片</button>
        <button type="button" class="btn btn-danger" id="btn-clear" disabled>清除全部</button>
        <label class="opt-check" for="opt-no-audio" title="合併時移除所有音軌">
          <input type="checkbox" id="opt-no-audio" />
          <span>不要聲音</span>
        </label>
        <div class="toolbar-spacer"></div>
        <button type="button" class="btn btn-primary" id="btn-merge" disabled>
          合併為一個影片
        </button>
      </div>

      <div class="extend-panel" aria-labelledby="extend-title">
        <div class="extend-head">
          <h3 id="extend-title">延長 / 循環</h3>
          <p class="hint" id="extend-estimate">可依次數或目標時長自動重複並裁切</p>
        </div>

        <div class="extend-modes" role="radiogroup" aria-label="延長方式">
          <label class="mode-chip">
            <input type="radio" name="loop-mode" value="once" checked />
            <span>播一次</span>
          </label>
          <label class="mode-chip">
            <input type="radio" name="loop-mode" value="count" />
            <span>重複次數</span>
          </label>
          <label class="mode-chip">
            <input type="radio" name="loop-mode" value="duration" />
            <span>目標時長</span>
          </label>
        </div>

        <div class="extend-fields" id="extend-fields-count" hidden>
          <label class="field" for="loop-count">
            <span class="field-label">重複幾次（整段序列）</span>
            <input
              type="number"
              id="loop-count"
              min="1"
              max="${LOOP_LIMITS.maxCount}"
              value="2"
              step="1"
              inputmode="numeric"
            />
          </label>
          <p class="field-hint">例如 3 = 依序播完整段合併結果共 3 遍</p>
        </div>

        <div class="extend-fields" id="extend-fields-duration" hidden>
          <div class="field-row">
            <label class="field" for="loop-hours">
              <span class="field-label">時</span>
              <input type="number" id="loop-hours" min="0" max="2" value="0" step="1" inputmode="numeric" />
            </label>
            <label class="field" for="loop-mins">
              <span class="field-label">分</span>
              <input type="number" id="loop-mins" min="0" max="59" value="1" step="1" inputmode="numeric" />
            </label>
            <label class="field" for="loop-secs">
              <span class="field-label">秒</span>
              <input type="number" id="loop-secs" min="0" max="59" value="0" step="1" inputmode="numeric" />
            </label>
          </div>
          <p class="field-hint">
            會自動循環整段內容，再裁切到目標時長（上限 ${LOOP_LIMITS.maxDurationSec / 3600} 小時）
          </p>
        </div>
      </div>
    </section>

    <section class="panel" aria-labelledby="clips-title">
      <div class="panel-head">
        <h2 id="clips-title">片段與首尾幀</h2>
        <p class="hint" id="clips-count">尚未加入影片</p>
      </div>
      <div id="clips-root">
        <div class="empty-state">
          <p>加入影片後，這裡會顯示每段的<strong>首幀</strong>與<strong>尾幀</strong>預覽。</p>
        </div>
      </div>

      <div class="progress-block" id="progress-block" aria-live="polite">
        <div class="progress-label">
          <strong id="progress-status">準備中…</strong>
          <span id="progress-pct">0%</span>
        </div>
        <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="progress-bar">
          <div class="progress-fill" id="progress-fill"></div>
        </div>
        <pre class="log-box" id="log-box" hidden></pre>
      </div>

      <div class="result-block" id="result-block">
        <h3>合併完成</h3>
        <video class="result-video" id="result-video" controls playsinline></video>
        <div class="result-actions">
          <a class="btn btn-primary" id="btn-download" download="merged.mp4">下載合併影片</a>
          <button type="button" class="btn btn-ghost" id="btn-dismiss-result">關閉預覽</button>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <p>使用瀏覽器內 FFmpeg 處理 · 畫面幀以 Canvas 擷取 · 資料不離開你的裝置</p>
  </footer>

  <div class="toast-region" id="toast-region" aria-live="assertive"></div>
`;

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  btnAddMore: document.getElementById('btn-add-more'),
  btnClear: document.getElementById('btn-clear'),
  btnMerge: document.getElementById('btn-merge'),
  optNoAudio: document.getElementById('opt-no-audio'),
  loopCount: document.getElementById('loop-count'),
  loopHours: document.getElementById('loop-hours'),
  loopMins: document.getElementById('loop-mins'),
  loopSecs: document.getElementById('loop-secs'),
  extendFieldsCount: document.getElementById('extend-fields-count'),
  extendFieldsDuration: document.getElementById('extend-fields-duration'),
  extendEstimate: document.getElementById('extend-estimate'),
  clipsRoot: document.getElementById('clips-root'),
  clipsCount: document.getElementById('clips-count'),
  progressBlock: document.getElementById('progress-block'),
  progressStatus: document.getElementById('progress-status'),
  progressPct: document.getElementById('progress-pct'),
  progressBar: document.getElementById('progress-bar'),
  progressFill: document.getElementById('progress-fill'),
  logBox: document.getElementById('log-box'),
  resultBlock: document.getElementById('result-block'),
  resultVideo: document.getElementById('result-video'),
  btnDownload: document.getElementById('btn-download'),
  btnDismissResult: document.getElementById('btn-dismiss-result'),
  toastRegion: document.getElementById('toast-region'),
  headerMeta: document.getElementById('header-meta'),
};

function getLoopMode() {
  const el = document.querySelector('input[name="loop-mode"]:checked');
  return el?.value || 'once';
}

function getTargetSecondsFromFields() {
  const h = Math.max(0, Math.floor(Number(els.loopHours.value) || 0));
  const m = Math.max(0, Math.floor(Number(els.loopMins.value) || 0));
  const s = Math.max(0, Math.floor(Number(els.loopSecs.value) || 0));
  return h * 3600 + m * 60 + s;
}

function baseSequenceDuration() {
  return clips
    .filter((c) => c.status === 'ready')
    .reduce((sum, c) => sum + (c.duration || 0), 0);
}

/** @returns {{ mode: 'once' | 'count' | 'duration', count?: number, targetSeconds?: number, baseDurationSec?: number }} */
function getLoopOptions() {
  const mode = getLoopMode();
  const baseDurationSec = baseSequenceDuration();
  if (mode === 'count') {
    const count = Math.floor(Number(els.loopCount.value) || 1);
    return { mode: 'count', count, baseDurationSec };
  }
  if (mode === 'duration') {
    return {
      mode: 'duration',
      targetSeconds: getTargetSecondsFromFields(),
      baseDurationSec,
    };
  }
  return { mode: 'once', baseDurationSec };
}

function syncExtendUI() {
  const mode = getLoopMode();
  els.extendFieldsCount.hidden = mode !== 'count';
  els.extendFieldsDuration.hidden = mode !== 'duration';

  const base = baseSequenceDuration();
  const baseLabel = base > 0 ? formatDuration(base) : '—';

  if (mode === 'once') {
    els.extendEstimate.textContent =
      base > 0 ? `輸出約 ${baseLabel}` : '選擇重複次數或目標時長可自動延長';
    return;
  }

  if (mode === 'count') {
    const count = Math.max(1, Math.floor(Number(els.loopCount.value) || 1));
    const out = base > 0 ? base * count : 0;
    els.extendEstimate.textContent =
      base > 0
        ? `基底 ${baseLabel} × ${count} 次 ≈ ${formatDuration(out)}`
        : `將重複整段序列 ${count} 次`;
    return;
  }

  const target = getTargetSecondsFromFields();
  if (target <= 0) {
    els.extendEstimate.textContent = '請設定目標時長（時 / 分 / 秒）';
    return;
  }
  if (base > 0) {
    const loops = Math.ceil(target / base);
    els.extendEstimate.textContent = `基底 ${baseLabel} → 循環約 ${loops} 次，裁切至 ${formatDuration(target)}`;
  } else {
    els.extendEstimate.textContent = `目標時長 ${formatDuration(target)}（加入影片後可預估循環次數）`;
  }
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
  el.textContent = message;
  els.toastRegion.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4200);
}

function revokeResult() {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  els.resultVideo.removeAttribute('src');
  els.resultVideo.load();
  els.resultBlock.classList.remove('is-visible');
  els.btnDownload.removeAttribute('href');
}

function setProgress(ratio, status) {
  if (typeof ratio === 'number' && Number.isFinite(ratio)) {
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    els.progressFill.style.width = `${pct}%`;
    els.progressPct.textContent = `${pct}%`;
    els.progressBar.setAttribute('aria-valuenow', String(pct));
  }
  if (status) els.progressStatus.textContent = status;
}

function appendLog(line) {
  if (!els.logBox.hidden) {
    const text = typeof line === 'string' ? line : String(line);
    els.logBox.textContent += `${text}\n`;
    els.logBox.scrollTop = els.logBox.scrollHeight;
  }
}

function updateToolbar() {
  const ready = clips.filter((c) => c.status === 'ready');
  const hasClips = clips.length > 0;
  els.btnClear.disabled = !hasClips || merging;
  els.btnMerge.disabled = ready.length === 0 || merging || clips.some((c) => c.status === 'loading');
  els.btnAddMore.disabled = merging;
  els.fileInput.disabled = merging;
  els.optNoAudio.disabled = merging;

  const loopInputs = document.querySelectorAll(
    'input[name="loop-mode"], #loop-count, #loop-hours, #loop-mins, #loop-secs',
  );
  loopInputs.forEach((el) => {
    el.disabled = merging;
  });

  if (!hasClips) {
    els.clipsCount.textContent = '尚未加入影片';
  } else {
    const totalDur = ready.reduce((sum, c) => sum + (c.duration || 0), 0);
    els.clipsCount.textContent = `${clips.length} 段 · 約 ${formatDuration(totalDur)} · 就緒 ${ready.length}`;
  }

  els.headerMeta.textContent = hasClips
    ? `${clips.length} 個檔案 · 本機處理`
    : '本機處理 · 不上傳伺服器';

  syncExtendUI();
}

function renderClips() {
  if (clips.length === 0) {
    els.clipsRoot.innerHTML = `
      <div class="empty-state">
        <p>加入影片後，這裡會顯示每段的<strong>首幀</strong>與<strong>尾幀</strong>預覽。</p>
      </div>
    `;
    updateToolbar();
    return;
  }

  const list = document.createElement('ul');
  list.className = 'clip-list';
  list.setAttribute('aria-label', '影片片段列表');

  clips.forEach((clip, index) => {
    const li = document.createElement('li');
    li.className = 'clip-card';
    li.dataset.id = clip.id;

    const statusHtml =
      clip.status === 'loading'
        ? `<span class="clip-status">正在擷取首尾幀…</span>`
        : clip.status === 'error'
          ? `<span class="clip-status is-error">${escapeHtml(clip.error || '讀取失敗')}</span>`
          : `<span class="clip-status is-ok">首尾幀就緒</span>`;

    const firstInner = clip.firstFrame
      ? `<img src="${clip.firstFrame}" alt="${escapeHtml(clip.name)} 首幀" />`
      : `<div class="placeholder">${clip.status === 'loading' ? '擷取中…' : '—'}</div>`;

    const lastInner = clip.lastFrame
      ? `<img src="${clip.lastFrame}" alt="${escapeHtml(clip.name)} 尾幀" />`
      : `<div class="placeholder">${clip.status === 'loading' ? '擷取中…' : '—'}</div>`;

    li.innerHTML = `
      <div class="clip-order">
        <span class="order-badge" aria-label="順序 ${index + 1}">${index + 1}</span>
        <div class="order-actions">
          <button type="button" class="icon-btn" data-action="up" data-id="${clip.id}" title="上移" aria-label="上移 ${escapeHtml(clip.name)}" ${index === 0 || merging ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 14l6-6 6 6"/></svg>
          </button>
          <button type="button" class="icon-btn" data-action="down" data-id="${clip.id}" title="下移" aria-label="下移 ${escapeHtml(clip.name)}" ${index === clips.length - 1 || merging ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 10l6 6 6-6"/></svg>
          </button>
          <button type="button" class="icon-btn danger" data-action="remove" data-id="${clip.id}" title="移除" aria-label="移除 ${escapeHtml(clip.name)}" ${merging ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </div>
      <div class="clip-body">
        <div class="clip-meta">
          <p class="clip-name" title="${escapeHtml(clip.name)}">${escapeHtml(clip.name)}</p>
          <div class="clip-stats">
            <span>${formatDuration(clip.duration)}</span>
            <span>${formatBytes(clip.size)}</span>
            <span>${clip.width && clip.height ? `${clip.width}×${clip.height}` : '—'}</span>
          </div>
        </div>
        <div class="frames-row">
          <div class="frame-cell">
            <span class="frame-label">首幀</span>
            <div class="frame-thumb">${firstInner}</div>
          </div>
          <div class="frame-connector" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14M14 7l5 5-5 5"/></svg>
            <span>→</span>
          </div>
          <div class="frame-cell">
            <span class="frame-label">尾幀</span>
            <div class="frame-thumb">${lastInner}</div>
          </div>
        </div>
        ${statusHtml}
      </div>
    `;

    list.appendChild(li);
  });

  els.clipsRoot.replaceChildren(list);
  updateToolbar();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function processClip(clip) {
  try {
    const info = await extractFrames(clip.file);
    const current = clips.find((c) => c.id === clip.id);
    if (!current) return;
    Object.assign(current, {
      firstFrame: info.firstFrame,
      lastFrame: info.lastFrame,
      duration: info.duration,
      width: info.width,
      height: info.height,
      status: 'ready',
      error: null,
    });
  } catch (err) {
    const current = clips.find((c) => c.id === clip.id);
    if (!current) return;
    current.status = 'error';
    current.error = err?.message || '無法擷取影格';
  }
  renderClips();
}

function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(f.name));
  if (files.length === 0) {
    toast('請選擇有效的影片檔案', 'error');
    return;
  }

  revokeResult();

  const newClips = files.map((file) => ({
    id: uid(),
    file,
    name: file.name,
    size: file.size,
    firstFrame: null,
    lastFrame: null,
    duration: null,
    width: null,
    height: null,
    status: /** @type {const} */ ('loading'),
    error: null,
  }));

  clips = [...clips, ...newClips];
  renderClips();
  toast(`已加入 ${newClips.length} 段影片`, 'success');

  for (const clip of newClips) {
    processClip(clip);
  }
}

function moveClip(id, dir) {
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= clips.length) return;
  const next = [...clips];
  [next[i], next[j]] = [next[j], next[i]];
  clips = next;
  renderClips();
}

function removeClip(id) {
  clips = clips.filter((c) => c.id !== id);
  renderClips();
  if (clips.length === 0) revokeResult();
}

function clearAll() {
  if (merging) return;
  clips = [];
  renderClips();
  revokeResult();
  els.progressBlock.classList.remove('is-visible');
  els.logBox.hidden = true;
  els.logBox.textContent = '';
  toast('已清除所有片段');
}

async function runMerge() {
  const ready = clips.filter((c) => c.status === 'ready');
  if (ready.length === 0 || merging) return;

  merging = true;
  revokeResult();
  updateToolbar();
  renderClips();

  els.progressBlock.classList.add('is-visible');
  els.logBox.hidden = false;
  els.logBox.textContent = '';
  setProgress(0, '載入 FFmpeg…');

  try {
    // Re-check files still readable before heavy work
    for (const clip of ready) {
      if (!(clip.file instanceof File) || clip.file.size <= 0) {
        throw new Error(`檔案無效或為空：${clip.name}`);
      }
    }

    const noAudio = Boolean(els.optNoAudio.checked);
    const loop = getLoopOptions();

    if (loop.mode === 'count') {
      if (loop.count < 1 || loop.count > LOOP_LIMITS.maxCount) {
        throw new Error(`重複次數請介於 1～${LOOP_LIMITS.maxCount}`);
      }
    }
    if (loop.mode === 'duration') {
      if (!loop.targetSeconds || loop.targetSeconds <= 0) {
        throw new Error('請設定大於 0 的目標時長');
      }
      if (loop.targetSeconds > LOOP_LIMITS.maxDurationSec) {
        throw new Error(
          `目標時長不可超過 ${LOOP_LIMITS.maxDurationSec / 3600} 小時`,
        );
      }
    }

    const blob = await mergeVideos(
      ready.map((c) => c.file),
      {
        noAudio,
        loop,
        onStatus: (s) => setProgress(undefined, s),
        onProgress: (p) => {
          if (typeof p === 'number' && Number.isFinite(p)) {
            setProgress(Math.min(p, 0.99), els.progressStatus.textContent);
          }
        },
        onLog: (msg) => appendLog(msg),
      },
    );

    setProgress(1, '完成');
    resultUrl = URL.createObjectURL(blob);
    els.resultVideo.src = resultUrl;
    els.btnDownload.href = resultUrl;
    els.btnDownload.download = `merged-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
    els.resultBlock.classList.add('is-visible');
    toast('合併完成，可預覽或下載', 'success');
    els.resultBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error(err);
    setProgress(0, '失敗');
    appendLog(err?.message || String(err));
    toast(err?.message || '合併失敗，請查看日誌', 'error');
  } finally {
    merging = false;
    updateToolbar();
    renderClips();
  }
}

/* —— Events —— */
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files?.length) {
    addFiles(els.fileInput.files);
    els.fileInput.value = '';
  }
});

els.btnAddMore.addEventListener('click', () => els.fileInput.click());
els.btnClear.addEventListener('click', clearAll);
els.btnMerge.addEventListener('click', runMerge);
els.btnDismissResult.addEventListener('click', revokeResult);

document.querySelectorAll('input[name="loop-mode"]').forEach((el) => {
  el.addEventListener('change', syncExtendUI);
});
['input', 'change'].forEach((evt) => {
  els.loopCount.addEventListener(evt, syncExtendUI);
  els.loopHours.addEventListener(evt, syncExtendUI);
  els.loopMins.addEventListener(evt, syncExtendUI);
  els.loopSecs.addEventListener(evt, syncExtendUI);
});

['dragenter', 'dragover'].forEach((type) => {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropzone.classList.add('is-dragover');
  });
});

['dragleave', 'drop'].forEach((type) => {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropzone.classList.remove('is-dragover');
  });
});

els.dropzone.addEventListener('drop', (e) => {
  const files = e.dataTransfer?.files;
  if (files?.length) addFiles(files);
});

els.clipsRoot.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || merging) return;
  const { action, id } = btn.dataset;
  if (action === 'up') moveClip(id, -1);
  if (action === 'down') moveClip(id, 1);
  if (action === 'remove') removeClip(id);
});

renderClips();
