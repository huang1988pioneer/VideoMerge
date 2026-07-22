/**
 * Speech-to-text (Whisper via Transformers.js) → SRT / WebVTT subtitles.
 */

/** @type {import('@huggingface/transformers').AutomaticSpeechRecognitionPipeline | null} */
let transcriber = null;
/** @type {Promise<unknown> | null} */
let loadPromise = null;

/**
 * Prefer models/dtypes that work with current onnxruntime-web.
 * q8-only Whisper often fails with:
 *   TransposeDQWeightsForMatMulNBits Missing required scale ...
 */
const LOAD_CANDIDATES = [
  // Full precision: largest but most compatible on WASM
  {
    model: 'Xenova/whisper-tiny',
    options: { dtype: 'fp32', device: 'wasm' },
    label: 'whisper-tiny fp32',
  },
  // Mixed: encoder lighter, decoder full (Whisper is sensitive to encoder quant)
  {
    model: 'Xenova/whisper-tiny',
    options: {
      dtype: {
        encoder_model: 'fp32',
        decoder_model_merged: 'fp32',
      },
      device: 'wasm',
    },
    label: 'whisper-tiny encoder/decoder fp32',
  },
  // Default pipeline (no dtype) — let library pick a safe variant
  {
    model: 'Xenova/whisper-tiny',
    options: { device: 'wasm' },
    label: 'whisper-tiny default',
  },
  // Community export fallback
  {
    model: 'onnx-community/whisper-tiny',
    options: { dtype: 'fp32', device: 'wasm' },
    label: 'onnx-community/whisper-tiny fp32',
  },
];

/**
 * @param {(msg: string) => void} [onStatus]
 * @param {(ratio: number) => void} [onProgress]
 */
export async function ensureTranscriber(onStatus, onProgress) {
  if (transcriber) return transcriber;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    onStatus?.('載入語音辨識模型（首次約需下載，請保持網路連線）…');
    const { pipeline, env } = await import('@huggingface/transformers');

    // Browser: allow remote model weights; cache successful downloads
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const progress_callback = (p) => {
      if (p?.status === 'progress' && typeof p.progress === 'number') {
        onProgress?.(Math.min(0.95, p.progress / 100));
        const name = p.file ? String(p.file).split('/').pop() : '';
        onStatus?.(`下載模型：${name} ${Math.round(p.progress)}%`);
      } else if (p?.status === 'done' && p.file) {
        onStatus?.(`模型檔就緒：${String(p.file).split('/').pop()}`);
      }
    };

    const errors = [];
    for (const candidate of LOAD_CANDIDATES) {
      try {
        onStatus?.(`嘗試載入：${candidate.label}…`);
        const asr = await pipeline(
          'automatic-speech-recognition',
          candidate.model,
          {
            ...candidate.options,
            progress_callback,
          },
        );
        transcriber = asr;
        onProgress?.(1);
        onStatus?.(`語音辨識模型載入完成（${candidate.label}）`);
        return asr;
      } catch (err) {
        const msg = err?.message || String(err);
        errors.push(`${candidate.label}: ${msg}`);
        onStatus?.(`載入失敗（${candidate.label}），改試下一組…`);
        // continue
      }
    }

    throw new Error(
      [
        '無法載入 Whisper 模型。',
        '請確認網路可連到 Hugging Face，並用 Ctrl+F5 強制重新整理後再試。',
        '若先前下載過損壞的 q8 模型，可清除本站快取後重試。',
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
      file.type.startsWith('video/') ? 'video' : 'audio',
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
    // safety
    if (offset > videoDurationSec + audioDurationSec * 2) break;
  }
  return out;
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
 * @returns {Promise<{ chunks: SubChunk[], text: string, srt: string, vtt: string }>}
 */
export async function transcribeAudioToSubtitles(file, opts = {}) {
  const { language = 'chinese', onStatus, onProgress, onLog } = opts;
  if (!file) throw new Error('請先選擇 MP3 / 音訊檔');

  const asr = await ensureTranscriber(onStatus, onProgress);
  onStatus?.('正在辨識語音內容…');
  onLog?.(`ASR 檔案：${file.name}（${file.size} bytes） language=${language || 'auto'}`);

  const url = URL.createObjectURL(file);
  try {
    /** @type {Record<string, unknown>} */
    const kwargs = {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    };
    // Multilingual whisper: null/undefined = auto detect
    if (language && language !== 'auto') {
      kwargs.language = language;
      kwargs.task = 'transcribe';
    }

    const result = await asr(url, kwargs);
    onLog?.(`ASR 完成，文字長度 ${(result?.text || '').length}`);

    /** @type {SubChunk[]} */
    let chunks = [];
    if (Array.isArray(result?.chunks) && result.chunks.length) {
      chunks = result.chunks
        .map((c) => ({
          timestamp: /** @type {[number, number]} */ (
            Array.isArray(c.timestamp)
              ? [c.timestamp[0] ?? 0, c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 1.5]
              : [0, 1.5]
          ),
          text: String(c.text || '').trim(),
        }))
        .filter((c) => c.text);
    } else if (result?.text) {
      // No timestamps — single cue for whole clip
      const dur = await getMediaDuration(file);
      chunks = [
        {
          timestamp: [0, Math.max(dur || 2, 2)],
          text: String(result.text).trim(),
        },
      ];
    }

    if (!chunks.length) {
      throw new Error('未能從音訊辨識出文字，請確認 MP3 含有人聲且夠清晰');
    }

    // Fix null end timestamps from whisper
    for (let i = 0; i < chunks.length; i++) {
      let [s, e] = chunks[i].timestamp;
      if (!Number.isFinite(e) || e <= s) {
        const next = chunks[i + 1]?.timestamp?.[0];
        e = Number.isFinite(next) ? next : s + 2;
        chunks[i].timestamp = [s, e];
      }
    }

    const srt = chunksToSrt(chunks);
    const vtt = chunksToVtt(chunks);
    onStatus?.(`字幕就緒（${chunks.length} 句）`);
    return { chunks, text: result?.text || chunks.map((c) => c.text).join(' '), srt, vtt };
  } finally {
    URL.revokeObjectURL(url);
  }
}
