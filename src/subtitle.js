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
  const preferChinese = !lang || lang === 'chinese';

  const asr = await ensureTranscriber(onStatus, onProgress, {
    preferBetterChinese: preferChinese,
  });

  onStatus?.('解碼音訊…');
  onLog?.(`ASR 檔案：${file.name}（${file.size} bytes） language=${lang || 'auto'}`);

  const waveform = await decodeAudioForWhisper(file, onLog);
  const audioDurationSec = waveform.length / SAMPLE_RATE;
  onLog?.(`波形長度 ${audioDurationSec.toFixed(2)}s · model=${loadedModelId || '?'}`);

  onStatus?.('正在辨識語音內容（可能需數十秒）…');
  onProgress?.(0.15);

  /** @type {Record<string, unknown>} */
  const kwargs = {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  };
  if (lang) {
    kwargs.language = lang;
    kwargs.task = 'transcribe';
  }

  // Pass raw waveform — more reliable than blob URL for local files
  let result;
  try {
    result = await asr(waveform, kwargs);
  } catch (err) {
    onLog?.(`ASR 第一次失敗：${err?.message || err}，改試 URL 輸入…`);
    const url = URL.createObjectURL(file);
    try {
      result = await asr(url, kwargs);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  onProgress?.(0.9);
  onLog?.(`ASR 原始回傳：${JSON.stringify(result)?.slice(0, 400) || typeof result}`);

  let chunks = parseAsrResult(result, audioDurationSec);
  const fullText = chunks.map((c) => c.text).join(' ').trim();
  onLog?.(`解析後 ${chunks.length} 句，文字：${fullText.slice(0, 120)}${fullText.length > 120 ? '…' : ''}`);

  // If tiny produced nothing useful for Chinese, try base once
  if (!chunks.length && preferChinese && loadedModelId && !loadedModelId.includes('base')) {
    onStatus?.('tiny 無結果，改載入 whisper-base 重試…');
    transcriber = null;
    loadedModelId = null;
    loadPromise = null;
    const asr2 = await ensureTranscriber(onStatus, onProgress, {
      preferBetterChinese: true,
    });
    result = await asr2(waveform, kwargs);
    chunks = parseAsrResult(result, audioDurationSec);
    onLog?.(`base 重試：${chunks.length} 句`);
  }

  if (!chunks.length) {
    throw new Error(
      '未能從音訊辨識出文字。請確認：① MP3 含清楚人聲 ② 語言選對 ③ 音量足夠。純音樂通常無法產生字幕。',
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
