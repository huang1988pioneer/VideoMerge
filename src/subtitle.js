/**
 * Speech-to-text (Whisper via Transformers.js) → SRT / WebVTT subtitles.
 * Decodes local MP3 via Web Audio API (blob URL alone is unreliable for Whisper).
 */

/** @type {import('@huggingface/transformers').AutomaticSpeechRecognitionPipeline | null} */
let transcriber = null;
/** @type {string | null} */
let loadedModelId = null;
/** @type {Promise<unknown> | null} */
let loadPromise = null;

const SAMPLE_RATE = 16000;
const PREFERRED_MODEL_KEY = 'videomerge.whisper.model';

/**
 * Prefer models/dtypes that work with current onnxruntime-web.
 * Browser Cache API keeps weights after first successful download.
 */
const LOAD_CANDIDATES = [
  {
    model: 'Xenova/whisper-tiny',
    options: { dtype: 'fp32', device: 'wasm' },
    label: 'whisper-tiny fp32',
  },
  {
    model: 'Xenova/whisper-tiny',
    options: { device: 'wasm' },
    label: 'whisper-tiny default',
  },
  {
    model: 'Xenova/whisper-base',
    options: { dtype: 'fp32', device: 'wasm' },
    label: 'whisper-base fp32（中文較準）',
  },
  {
    model: 'onnx-community/whisper-tiny',
    options: { dtype: 'fp32', device: 'wasm' },
    label: 'onnx-community/whisper-tiny fp32',
  },
];

function getPreferredModelId() {
  try {
    return sessionStorage.getItem(PREFERRED_MODEL_KEY) || localStorage.getItem(PREFERRED_MODEL_KEY);
  } catch {
    return null;
  }
}

function setPreferredModelId(modelId) {
  try {
    sessionStorage.setItem(PREFERRED_MODEL_KEY, modelId);
    localStorage.setItem(PREFERRED_MODEL_KEY, modelId);
  } catch {
    /* private mode etc. */
  }
}

/**
 * @param {{ preferBetterChinese?: boolean }} [opts]
 */
function buildCandidateOrder(opts = {}) {
  const preferBase = Boolean(opts.preferBetterChinese);
  const preferred = getPreferredModelId();
  let order = [...LOAD_CANDIDATES];

  if (preferBase) {
    order = [
      ...order.filter((c) => c.model.includes('base')),
      ...order.filter((c) => !c.model.includes('base')),
    ];
  }

  // Always try last successful model first (cached path)
  if (preferred) {
    order = [
      ...order.filter((c) => c.model === preferred),
      ...order.filter((c) => c.model !== preferred),
    ];
  }
  return order;
}

/**
 * @param {(msg: string) => void} [onStatus]
 * @param {(ratio: number) => void} [onProgress]
 * @param {{ preferBetterChinese?: boolean }} [opts]
 */
export async function ensureTranscriber(onStatus, onProgress, opts = {}) {
  // Same page session: model already in memory — no download
  if (transcriber && loadedModelId) {
    onStatus?.(`使用記憶體中的模型（${loadedModelId}，無需重新下載）`);
    onProgress?.(1);
    return transcriber;
  }
  if (loadPromise) return loadPromise;

  const order = buildCandidateOrder(opts);
  const preferred = getPreferredModelId();

  loadPromise = (async () => {
    onStatus?.(
      preferred
        ? '載入語音辨識模型（優先讀取瀏覽器快取，通常很快）…'
        : '載入語音辨識模型（僅首次需下載，之後會快取）…',
    );
    const { pipeline, env } = await import('@huggingface/transformers');

    env.allowLocalModels = false;
    env.useBrowserCache = true; // Cache API / IndexedDB — survives refresh

    let sawNetworkProgress = false;
    const progress_callback = (p) => {
      if (p?.status === 'progress' && typeof p.progress === 'number') {
        // Slow progress usually means real download; instant 100% often cache
        if (p.progress < 100 && p.progress > 0) sawNetworkProgress = true;
        onProgress?.(Math.min(0.95, p.progress / 100));
        const name = p.file ? String(p.file).split('/').pop() : '';
        onStatus?.(
          sawNetworkProgress
            ? `下載模型：${name} ${Math.round(p.progress)}%（僅首次）`
            : `讀取模型：${name} ${Math.round(p.progress)}%`,
        );
      } else if (p?.status === 'done' && p.file) {
        const name = String(p.file).split('/').pop();
        onStatus?.(
          sawNetworkProgress ? `已下載並快取：${name}` : `已從快取載入：${name}`,
        );
      }
    };

    const errors = [];
    for (const candidate of order) {
      try {
        onStatus?.(`載入：${candidate.label}…`);
        const t0 = performance.now();
        const asr = await pipeline(
          'automatic-speech-recognition',
          candidate.model,
          {
            ...candidate.options,
            progress_callback,
          },
        );
        const ms = Math.round(performance.now() - t0);
        transcriber = asr;
        loadedModelId = candidate.model;
        setPreferredModelId(candidate.model);
        onProgress?.(1);
        onStatus?.(
          sawNetworkProgress || ms > 8000
            ? `模型就緒（${candidate.label}，${(ms / 1000).toFixed(1)}s，已寫入快取，下次會更快）`
            : `模型就緒（${candidate.label}，${(ms / 1000).toFixed(1)}s，多半來自快取）`,
        );
        return asr;
      } catch (err) {
        const msg = err?.message || String(err);
        errors.push(`${candidate.label}: ${msg}`);
        onStatus?.(`載入失敗（${candidate.label}），改試下一組…`);
      }
    }

    throw new Error(
      [
        '無法載入 Whisper 模型。',
        '請確認網路可連到 Hugging Face。',
        '若曾清除網站資料，需重新下載一次。',
        errors.join(' | '),
      ].join(' '),
    );
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err instanceof Error
      ? err
      : new Error(`無法載入 Whisper 模型。${err?.message || err}`);
  }
}

/**
 * Decode File/Blob to mono Float32Array @ 16 kHz for Whisper.
 * @param {File | Blob} file
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<Float32Array>}
 */
export async function decodeAudioForWhisper(file, onLog) {
  if (!file) throw new Error('找不到音訊檔');

  // 1) Preferred: Web Audio API (works with local File, MP3/WAV/M4A)
  try {
    const ab = await file.arrayBuffer();
    if (!ab.byteLength) throw new Error('音訊檔是空的');

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('瀏覽器不支援 AudioContext');

    const ctx = new AudioCtx();
    let audioBuffer;
    try {
      // slice copy: decodeAudioData may detach the buffer
      audioBuffer = await ctx.decodeAudioData(ab.slice(0));
    } finally {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }

    const { numberOfChannels, length, sampleRate } = audioBuffer;
    onLog?.(
      `音訊解碼：${(length / sampleRate).toFixed(1)}s · ${sampleRate}Hz · ${numberOfChannels}ch`,
    );

    // Mixdown to mono
    const mono = new Float32Array(length);
    for (let c = 0; c < numberOfChannels; c++) {
      const ch = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += ch[i] / numberOfChannels;
    }

    // RMS energy check (silence → empty ASR)
    let sumSq = 0;
    const step = Math.max(1, Math.floor(mono.length / 20000));
    let n = 0;
    for (let i = 0; i < mono.length; i += step) {
      sumSq += mono[i] * mono[i];
      n += 1;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    onLog?.(`音量 RMS≈${rms.toFixed(5)}`);
    if (rms < 1e-4) {
      throw new Error(
        '音訊幾乎無聲（或解碼失敗）。請確認 MP3 含人聲且音量正常。',
      );
    }

    if (sampleRate === SAMPLE_RATE) return mono;

    // Linear resample → 16 kHz
    const newLength = Math.max(1, Math.round((length * SAMPLE_RATE) / sampleRate));
    const out = new Float32Array(newLength);
    const ratio = length / newLength;
    for (let i = 0; i < newLength; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, length - 1);
      const t = src - i0;
      out[i] = mono[i0] * (1 - t) + mono[i1] * t;
    }
    onLog?.(`已重採樣至 ${SAMPLE_RATE} Hz（${out.length} samples）`);
    return out;
  } catch (err) {
    onLog?.(`Web Audio 解碼失敗，改試 transformers.read_audio：${err?.message || err}`);
  }

  // 2) Fallback: transformers read_audio (fetch-based)
  const url = URL.createObjectURL(file);
  try {
    const { read_audio } = await import('@huggingface/transformers');
    const audio = await read_audio(url, SAMPLE_RATE);
    if (!(audio instanceof Float32Array) || !audio.length) {
      throw new Error('read_audio 回傳空資料');
    }
    onLog?.(`read_audio 成功：${audio.length} samples @ ${SAMPLE_RATE}Hz`);
    return audio;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @param {number} sec
 * @param {'srt' | 'vtt'} style
 */
function formatTimestamp(sec, style) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  if (style === 'vtt') {
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  }
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * @typedef {{ timestamp: [number, number], text: string }} SubChunk
 */

/**
 * Character weight for timing (CJK counts as 1, latin ~0.5, space low).
 * @param {string} text
 */
export function scriptWeight(text) {
  let w = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) w += 0.15;
    else if (/[\u3400-\u9fff\uF900-\uFAFF]/.test(ch)) w += 1;
    else if (/[0-9]/.test(ch)) w += 0.6;
    else w += 0.45;
  }
  return Math.max(0.5, w);
}

/**
 * Split plain script into subtitle lines (Chinese/English punctuation + newlines).
 * If text looks like SRT/VTT, returns null (caller should parse timed format).
 * @param {string} raw
 * @returns {string[]}
 */
export function splitScriptIntoLines(raw) {
  const text = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return [];

  // Already timed? leave to parseTimedScript
  if (
    /^WEBVTT/i.test(text) ||
    /^\d+\s*\n\d{1,2}:\d{2}/m.test(text) ||
    /\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*/.test(text)
  ) {
    return null;
  }

  // Prefer explicit line breaks first
  const byLine = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  // If user wrote one long paragraph, split on sentence ends
  const lines = [];
  for (const line of byLine) {
    // Keep short lines as-is
    if (line.length <= 40 || !/[。！？!?.；;]/.test(line)) {
      lines.push(line);
      continue;
    }
    // Split but keep delimiter with previous clause
    const parts = line.split(/(?<=[。！？!?.；;])\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) {
      lines.push(line);
    } else {
      for (const p of parts) {
        // Further split very long clauses
        if (p.length > 48) {
          let buf = '';
          for (const ch of p) {
            buf += ch;
            if (buf.length >= 36 && /[，,、\s]/.test(ch)) {
              lines.push(buf.trim());
              buf = '';
            }
          }
          if (buf.trim()) lines.push(buf.trim());
        } else {
          lines.push(p);
        }
      }
    }
  }

  return lines.filter(Boolean);
}

/**
 * Parse user-provided SRT or simple timed lines into chunks.
 * Supports:
 *  - Standard SRT
 *  - WebVTT
 *  - Lines like: [00:01.00-00:03.50] 字幕文字
 *  - Lines like: 00:01 --> 00:03 字幕
 * @param {string} raw
 * @returns {SubChunk[] | null}
 */
export function parseTimedScript(raw) {
  const text = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return null;

  /** @type {SubChunk[]} */
  const chunks = [];

  const toSec = (h, m, s, ms) => {
    const frac = ms != null ? Number(`0.${String(ms).padEnd(3, '0').slice(0, 3)}`) : 0;
    return (
      (Number(h) || 0) * 3600 +
      (Number(m) || 0) * 60 +
      (Number(s) || 0) +
      frac
    );
  };

  const parseTs = (str) => {
    const t = str.trim().replace(',', '.');
    let m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (m) return toSec(m[1] || 0, m[2], m[3], m[4]);
    m = t.match(/^(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (m) return toSec(0, m[1], m[2], m[3]);
    m = t.match(/^(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]);
    return NaN;
  };

  // SRT / VTT blocks with -->
  if (/\d{1,2}:\d{2}.*-->/.test(text) || /^WEBVTT/i.test(text)) {
    const body = text.replace(/^WEBVTT[^\n]*\n+/i, '');
    const blocks = body.split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const timeLine = lines.find((l) => l.includes('-->'));
      if (!timeLine) continue;
      const [a, b] = timeLine.split('-->').map((x) => x.trim());
      const start = parseTs(a.split(/\s+/)[0]);
      const end = parseTs(b.split(/\s+/)[0]);
      const cueText = lines
        .filter((l) => l !== timeLine && !/^\d+$/.test(l))
        .join('\n')
        .trim();
      if (cueText && Number.isFinite(start) && Number.isFinite(end) && end > start) {
        chunks.push({ timestamp: [start, end], text: cueText });
      }
    }
    return chunks.length ? chunks : null;
  }

  // [mm:ss-mm:ss] text  or  [0:01.0-0:03.0] text
  const bracketRe =
    /^\[?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?|\d+(?:\.\d+)?)\s*[-–—~]\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?|\d+(?:\.\d+)?)\s*\]?\s*(.+)$/;
  for (const line of text.split('\n')) {
    const m = line.trim().match(bracketRe);
    if (!m) continue;
    const start = parseTs(m[1]);
    const end = parseTs(m[2]);
    const cue = m[3].trim();
    if (cue && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      chunks.push({ timestamp: [start, end], text: cue });
    }
  }
  return chunks.length ? chunks : null;
}

/**
 * Build timed subtitles from plain script + total duration (weighted by text length).
 * @param {string} scriptText
 * @param {number} durationSec
 * @param {{
 *   minCueSec?: number,
 *   maxCueSec?: number,
 *   gapSec?: number,
 * }} [opts]
 * @returns {{ chunks: SubChunk[], srt: string, vtt: string, text: string, source: 'timed' | 'script' }}
 */
export function scriptToSubtitles(scriptText, durationSec, opts = {}) {
  const minCueSec = opts.minCueSec ?? 1.0;
  const maxCueSec = opts.maxCueSec ?? 8.0;
  const gapSec = opts.gapSec ?? 0.08;

  const timed = parseTimedScript(scriptText);
  if (timed?.length) {
    return {
      chunks: timed,
      srt: chunksToSrt(timed),
      vtt: chunksToVtt(timed),
      text: timed.map((c) => c.text).join(' '),
      source: 'timed',
    };
  }

  const lines = splitScriptIntoLines(scriptText);
  if (!lines.length) {
    throw new Error('語音稿是空的，請貼上或上傳文字稿');
  }

  const dur = Number(durationSec);
  if (!Number.isFinite(dur) || dur <= 0.5) {
    throw new Error('無法取得影片／音訊時長，請先加入影片（或選擇音軌）再上字幕');
  }

  const weights = lines.map((l) => scriptWeight(l));
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;

  // Available time for cues (leave tiny tail margin)
  const usable = Math.max(dur - 0.05, lines.length * minCueSec * 0.5);
  /** @type {SubChunk[]} */
  const chunks = [];
  let t = 0;

  for (let i = 0; i < lines.length; i++) {
    const share = (weights[i] / totalW) * usable;
    let len = Math.min(maxCueSec, Math.max(minCueSec, share));
    // Last cue stretches to end
    if (i === lines.length - 1) {
      len = Math.max(minCueSec, dur - t);
    } else if (t + len > dur - (lines.length - i - 1) * minCueSec) {
      len = Math.max(minCueSec, (dur - t) / (lines.length - i));
    }
    let end = Math.min(dur, t + len);
    if (end <= t) end = Math.min(dur, t + minCueSec);
    chunks.push({ timestamp: [t, end], text: lines[i] });
    t = end + (i < lines.length - 1 ? gapSec : 0);
    if (t >= dur && i < lines.length - 1) {
      // Compress remaining into leftover — rare
      break;
    }
  }

  // If we stopped early due to time, append rest into last cue text
  if (chunks.length < lines.length && chunks.length) {
    const rest = lines.slice(chunks.length).join(' ');
    const last = chunks[chunks.length - 1];
    last.text = `${last.text} ${rest}`.trim();
    last.timestamp[1] = dur;
  }

  return {
    chunks,
    srt: chunksToSrt(chunks),
    vtt: chunksToVtt(chunks),
    text: lines.join(' '),
    source: 'script',
  };
}

/**
 * @param {SubChunk[]} chunks
 * @returns {string}
 */
export function chunksToSrt(chunks) {
  const lines = [];
  let idx = 1;
  for (const c of chunks) {
    const text = (c.text || '').trim();
    if (!text) continue;
    let [start, end] = c.timestamp || [0, 0];
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end) || end <= start) end = start + 1.5;
    lines.push(String(idx));
    lines.push(
      `${formatTimestamp(start, 'srt')} --> ${formatTimestamp(end, 'srt')}`,
    );
    lines.push(text);
    lines.push('');
    idx += 1;
  }
  return lines.join('\n');
}

/**
 * @param {SubChunk[]} chunks
 * @returns {string}
 */
export function chunksToVtt(chunks) {
  const lines = ['WEBVTT', ''];
  let idx = 1;
  for (const c of chunks) {
    const text = (c.text || '').trim();
    if (!text) continue;
    let [start, end] = c.timestamp || [0, 0];
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end) || end <= start) end = start + 1.5;
    lines.push(String(idx));
    lines.push(
      `${formatTimestamp(start, 'vtt')} --> ${formatTimestamp(end, 'vtt')}`,
    );
    lines.push(text);
    lines.push('');
    idx += 1;
  }
  return lines.join('\n');
}

/**
 * @param {File | Blob} file
 * @returns {Promise<number>}
 */
export async function getMediaDuration(file) {
  const url = URL.createObjectURL(file);
  try {
    const el = document.createElement(
      file.type?.startsWith('video/') ? 'video' : 'audio',
    );
    el.preload = 'metadata';
    el.src = url;
    await new Promise((resolve, reject) => {
      el.addEventListener('loadedmetadata', resolve, { once: true });
      el.addEventListener(
        'error',
        () => reject(new Error('無法讀取音訊時長')),
        { once: true },
      );
    });
    const d = el.duration;
    return Number.isFinite(d) ? d : 0;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * If video is longer than one pass of the audio (looped BGM), tile cues.
 * @param {SubChunk[]} chunks
 * @param {number} audioDurationSec
 * @param {number} videoDurationSec
 * @returns {SubChunk[]}
 */
export function tileChunksToDuration(chunks, audioDurationSec, videoDurationSec) {
  if (!chunks.length) return chunks;
  if (
    !Number.isFinite(audioDurationSec) ||
    audioDurationSec <= 0 ||
    !Number.isFinite(videoDurationSec) ||
    videoDurationSec <= audioDurationSec + 0.25
  ) {
    return chunks;
  }

  const out = [];
  let offset = 0;
  while (offset < videoDurationSec - 0.05) {
    for (const c of chunks) {
      let [s, e] = c.timestamp || [0, 0];
      if (!Number.isFinite(s)) s = 0;
      if (!Number.isFinite(e) || e <= s) e = s + 1.5;
      const ns = s + offset;
      const ne = Math.min(e + offset, videoDurationSec);
      if (ns >= videoDurationSec) break;
      if (ne > ns + 0.05) {
        out.push({ timestamp: [ns, ne], text: c.text });
      }
    }
    offset += audioDurationSec;
    if (offset > videoDurationSec + audioDurationSec * 2) break;
  }
  return out;
}

/**
 * Normalize Whisper language option.
 * @param {string | null | undefined} language
 */
function normalizeLanguage(language) {
  if (!language || language === 'auto') return null;
  const map = {
    chinese: 'chinese',
    zh: 'chinese',
    'zh-tw': 'chinese',
    'zh-cn': 'chinese',
    中文: 'chinese',
    english: 'english',
    en: 'english',
  };
  const key = String(language).toLowerCase();
  return map[key] || language;
}

/**
 * Parse various ASR return shapes into chunks.
 * @param {any} result
 * @param {number} audioDurationSec
 * @returns {SubChunk[]}
 */
function parseAsrResult(result, audioDurationSec) {
  /** @type {SubChunk[]} */
  const chunks = [];

  const pushChunk = (text, start, end) => {
    const t = String(text || '')
      .replace(/\[.*?\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return;
    // Whisper silence hallucinations
    if (/^(\.|…|\.\.\.|♪|\[Music\]|\[音樂\]|thank you\.?|thanks for watching\.?)$/i.test(t)) {
      return;
    }
    let s = Number(start);
    let e = Number(end);
    if (!Number.isFinite(s) || s < 0) s = 0;
    if (!Number.isFinite(e) || e <= s) e = s + 1.5;
    chunks.push({ timestamp: [s, e], text: t });
  };

  // Array of segment results
  const list = Array.isArray(result) ? result : [result];
  for (const item of list) {
    if (!item) continue;
    if (Array.isArray(item.chunks) && item.chunks.length) {
      for (const c of item.chunks) {
        const ts = c.timestamp;
        const start = Array.isArray(ts) ? ts[0] : 0;
        const end = Array.isArray(ts) ? ts[1] : start + 1.5;
        pushChunk(c.text, start, end);
      }
    } else if (item.text) {
      pushChunk(
        item.text,
        0,
        Math.max(audioDurationSec || 2, 2),
      );
    }
  }

  // Fix null / overlapping ends
  for (let i = 0; i < chunks.length; i++) {
    let [s, e] = chunks[i].timestamp;
    if (!Number.isFinite(e) || e <= s) {
      const next = chunks[i + 1]?.timestamp?.[0];
      e = Number.isFinite(next) && next > s ? next : s + 2;
      chunks[i].timestamp = [s, e];
    }
  }

  return chunks;
}

/** Manual slice length — small enough that WASM Whisper finishes in reasonable time */
const SLICE_SEC = 15;
const SLICE_OVERLAP_SEC = 0.5;
/** Per-slice timeout (whisper-tiny on WASM: ~15s audio can take 30–90s) */
const SLICE_TIMEOUT_MS = 90_000;
/** Hard cap so jobs don't run forever */
const MAX_ASR_SEC = 10 * 60;

/**
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 * @template T
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `${label} 逾時（>${Math.round(ms / 1000)} 秒）。瀏覽器內辨識較慢，請換較短 MP3 或稍後再試。`,
        ),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function yieldToUi() {
  return new Promise((resolve) => {
    // Double rAF + timeout so status text actually paints before heavy WASM work
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  });
}

/**
 * Run ASR on short slices with progress + timeout (avoids infinite hang on long files).
 * @param {import('@huggingface/transformers').AutomaticSpeechRecognitionPipeline} asr
 * @param {Float32Array} waveform
 * @param {Record<string, unknown>} baseKwargs
 * @param {{
 *   onStatus?: (msg: string) => void,
 *   onProgress?: (ratio: number) => void,
 *   onLog?: (msg: string) => void,
 * }} hooks
 * @returns {Promise<SubChunk[]>}
 */
async function transcribeInSlices(asr, waveform, baseKwargs, hooks) {
  const { onStatus, onProgress, onLog } = hooks;
  const totalSec = waveform.length / SAMPLE_RATE;
  const stepSec = SLICE_SEC - SLICE_OVERLAP_SEC;
  const numSlices = Math.max(1, Math.ceil(totalSec / stepSec));
  /** @type {SubChunk[]} */
  const all = [];
  const t0 = Date.now();

  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    onStatus?.(
      `辨識進行中…已 ${elapsed} 秒（瀏覽器內轉寫偏慢，請勿關閉分頁）`,
    );
  }, 2000);

  try {
    for (let i = 0; i < numSlices; i++) {
      const startSec = i * stepSec;
      const endSec = Math.min(totalSec, startSec + SLICE_SEC);
      const startSample = Math.floor(startSec * SAMPLE_RATE);
      const endSample = Math.min(waveform.length, Math.floor(endSec * SAMPLE_RATE));
      if (endSample <= startSample) continue;

      const slice = waveform.subarray(startSample, endSample);
      const sliceDur = (endSample - startSample) / SAMPLE_RATE;
      const elapsed = Math.round((Date.now() - t0) / 1000);

      onStatus?.(
        `辨識 ${i + 1}/${numSlices}（${startSec.toFixed(0)}–${endSec.toFixed(0)}s / 共 ${totalSec.toFixed(0)}s）· 已 ${elapsed}s`,
      );
      onProgress?.(0.1 + (0.85 * i) / numSlices);
      onLog?.(
        `ASR 片段 ${i + 1}/${numSlices}: ${startSec.toFixed(1)}–${endSec.toFixed(1)}s (${sliceDur.toFixed(1)}s, ${slice.length} samples)`,
      );

      // Let UI update before blocking WASM
      await yieldToUi();

      // No nested chunk_length_s — slice is already short
      /** @type {Record<string, unknown>} */
      const kwargs = {
        ...baseKwargs,
        return_timestamps: true,
        // Cap generation so silence doesn't spin forever
        max_new_tokens: 128,
      };
      delete kwargs.chunk_length_s;
      delete kwargs.stride_length_s;

      let result;
      try {
        result = await withTimeout(
          asr(slice, kwargs),
          SLICE_TIMEOUT_MS,
          `第 ${i + 1}/${numSlices} 段`,
        );
      } catch (err) {
        onLog?.(`片段 ${i + 1} 失敗：${err?.message || err}`);
        // Continue other slices rather than abort entire job
        continue;
      }

      const part = parseAsrResult(result, sliceDur);
      for (const c of part) {
        const [s, e] = c.timestamp;
        // Skip cues fully inside overlap with previous slice (except first)
        if (i > 0 && s < SLICE_OVERLAP_SEC * 0.8) continue;
        all.push({
          timestamp: [s + startSec, e + startSec],
          text: c.text,
        });
      }

      onLog?.(
        `片段 ${i + 1} 完成：+${part.length} 句 · 累計 ${all.length} · 「${part.map((p) => p.text).join(' ').slice(0, 60)}」`,
      );
      onProgress?.(0.1 + (0.85 * (i + 1)) / numSlices);
      await yieldToUi();
    }
  } finally {
    clearInterval(heartbeat);
  }

  // Sort & light merge of adjacent identical lines
  all.sort((a, b) => a.timestamp[0] - b.timestamp[0]);
  return all;
}

/**
 * Transcribe an audio File (e.g. MP3) into timed subtitle chunks.
 * @param {File} file
 * @param {{
 *   language?: string | null,
 *   onStatus?: (msg: string) => void,
 *   onProgress?: (ratio: number) => void,
 *   onLog?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<{ chunks: SubChunk[], text: string, srt: string, vtt: string, modelId: string | null }>}
 */
export async function transcribeAudioToSubtitles(file, opts = {}) {
  const { language = 'chinese', onStatus, onProgress, onLog } = opts;
  if (!file) throw new Error('請先選擇 MP3 / 音訊檔');

  const lang = normalizeLanguage(language);

  // Prefer tiny for speed — base is often too slow in-browser and feels "stuck"
  const asr = await ensureTranscriber(onStatus, onProgress, {
    preferBetterChinese: false,
  });

  onStatus?.('解碼音訊…');
  onLog?.(`ASR 檔案：${file.name}（${file.size} bytes） language=${lang || 'auto'}`);

  let waveform = await decodeAudioForWhisper(file, onLog);
  let audioDurationSec = waveform.length / SAMPLE_RATE;
  onLog?.(`波形長度 ${audioDurationSec.toFixed(2)}s · model=${loadedModelId || '?'}`);

  if (audioDurationSec > MAX_ASR_SEC) {
    onLog?.(
      `音訊 ${audioDurationSec.toFixed(0)}s 超過上限 ${MAX_ASR_SEC}s，只辨識前 ${MAX_ASR_SEC / 60} 分鐘`,
    );
    onStatus?.(`音訊較長，僅辨識前 ${MAX_ASR_SEC / 60} 分鐘…`);
    waveform = waveform.subarray(0, Math.floor(MAX_ASR_SEC * SAMPLE_RATE));
    audioDurationSec = waveform.length / SAMPLE_RATE;
  }

  /** @type {Record<string, unknown>} */
  const baseKwargs = {
    return_timestamps: true,
    max_new_tokens: 128,
  };
  if (lang) {
    baseKwargs.language = lang;
    baseKwargs.task = 'transcribe';
  }

  onStatus?.('開始分段辨識（每段約 15 秒音訊）…');
  onProgress?.(0.1);

  const chunks = await transcribeInSlices(asr, waveform, baseKwargs, {
    onStatus,
    onProgress,
    onLog,
  });

  const fullText = chunks.map((c) => c.text).join(' ').trim();
  onLog?.(
    `解析後 ${chunks.length} 句，文字：${fullText.slice(0, 120)}${fullText.length > 120 ? '…' : ''}`,
  );

  if (!chunks.length) {
    throw new Error(
      '未能從音訊辨識出文字。請確認：① MP3 含清楚人聲 ② 語言選對 ③ 音量足夠。純音樂通常無法產生字幕。若各段都逾時，請換較短 MP3 再試。',
    );
  }

  const srt = chunksToSrt(chunks);
  const vtt = chunksToVtt(chunks);
  if (!srt.trim() || !vtt.includes('-->')) {
    throw new Error('字幕檔產生失敗（內容為空）');
  }

  onStatus?.(`字幕就緒（${chunks.length} 句）`);
  onProgress?.(1);
  return {
    chunks,
    text: fullText || chunks.map((c) => c.text).join(' '),
    srt,
    vtt,
    modelId: loadedModelId,
  };
}
