import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpeg = null;
let loadPromise = null;

/** Prefer esm for Vite (per ffmpeg.wasm docs). Multiple CDNs for reliability. */
const CORE_CANDIDATES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm',
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd',
];

/**
 * Read a File/Blob into Uint8Array without FileReader.
 * FileReader often throws "File could not be read! Code=8" on Windows
 * for some paths / cloud-synced / locked files.
 * @param {File | Blob} file
 * @returns {Promise<Uint8Array>}
 */
async function readBytes(file) {
  if (!file) throw new Error('找不到影片檔案');
  if (!(file instanceof Blob)) {
    throw new Error('無效的檔案物件');
  }
  if (file.size === 0) {
    throw new Error(`檔案是空的：${file.name || 'unknown'}`);
  }

  try {
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (err) {
    // Last resort: Response.arrayBuffer (also avoids FileReader)
    try {
      const buffer = await new Response(file).arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      const name = file instanceof File ? file.name : 'blob';
      throw new Error(
        `無法讀取檔案「${name}」。請確認檔案仍存在、未被其他程式鎖定，並改從本機磁碟選擇（不要用僅線上可用的雲端捷徑）。原始錯誤：${err?.message || err}`,
      );
    }
  }
}

/**
 * @param {string} base
 * @param {(msg: string) => void} [onLog]
 * @param {(ratio: number) => void} [onProgress]
 */
async function loadFromBase(base, onLog, onProgress) {
  const instance = new FFmpeg();
  if (onLog) instance.on('log', ({ message }) => onLog(message));
  if (onProgress) instance.on('progress', ({ progress }) => onProgress(progress));

  const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm');
  await instance.load({ coreURL, wasmURL });
  return instance;
}

/**
 * Lazy-load ffmpeg.wasm (single-thread core).
 * @param {(msg: string) => void} [onLog]
 * @param {(ratio: number) => void} [onProgress]
 */
export async function ensureFFmpeg(onLog, onProgress) {
  if (ffmpeg?.loaded) {
    if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
    if (onProgress) ffmpeg.on('progress', ({ progress }) => onProgress(progress));
    return ffmpeg;
  }

  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const errors = [];
    for (const base of CORE_CANDIDATES) {
      try {
        onLog?.(`載入 FFmpeg 核心：${base}`);
        const instance = await loadFromBase(base, onLog, onProgress);
        ffmpeg = instance;
        onLog?.('FFmpeg 載入完成');
        return instance;
      } catch (err) {
        errors.push(`${base}: ${err?.message || err}`);
        onLog?.(`載入失敗，嘗試下一個來源… (${err?.message || err})`);
      }
    }
    throw new Error(
      `無法載入 FFmpeg（需要網路下載核心約 30MB）。\n${errors.join('\n')}`,
    );
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

function extFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  const ext = (m?.[1] || 'mp4').toLowerCase();
  // Keep MEMFS names simple (ASCII only)
  if (!/^[a-z0-9]+$/.test(ext)) return 'mp4';
  return ext;
}

/**
 * Run ffmpeg exec; throw with logs if non-zero.
 * @param {FFmpeg} ff
 * @param {string[]} args
 * @param {(msg: string) => void} [onLog]
 */
async function execOrThrow(ff, args, onLog) {
  onLog?.(`$ ffmpeg ${args.join(' ')}`);
  const code = await ff.exec(args);
  if (code !== 0) {
    throw new Error(`FFmpeg 結束代碼 ${code}（指令：ffmpeg ${args.join(' ')}）`);
  }
}

/**
 * Normalize one clip to H.264/AAC 1280x720 @ 30fps.
 * @param {FFmpeg} ff
 * @param {string} input
 * @param {string} output
 * @param {(msg: string) => void} [onLog]
 */
async function normalizeClip(ff, input, output, onLog) {
  const vf =
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p';

  try {
    await execOrThrow(
      ff,
      [
        '-i',
        input,
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-b:a',
        '128k',
        '-shortest',
        '-y',
        output,
      ],
      onLog,
    );
  } catch (err) {
    onLog?.(`含音訊轉檔失敗，改為純影像：${err?.message || err}`);
    await execOrThrow(
      ff,
      [
        '-i',
        input,
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-an',
        '-y',
        output,
      ],
      onLog,
    );
  }
}

/**
 * Merge multiple video Files into one MP4 Blob.
 * @param {File[]} files
 * @param {{
 *   onLog?: (msg: string) => void,
 *   onProgress?: (ratio: number) => void,
 *   onStatus?: (status: string) => void,
 * }} [hooks]
 * @returns {Promise<Blob>}
 */
export async function mergeVideos(files, hooks = {}) {
  if (!files?.length) throw new Error('請至少選擇一段影片');

  const { onLog, onProgress, onStatus } = hooks;
  const ff = await ensureFFmpeg(onLog, onProgress);

  const written = [];
  try {
    onStatus?.('讀取並寫入暫存檔…');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = file?.name || `clip-${i}`;
      onStatus?.(`讀取第 ${i + 1} / ${files.length} 段：${label}`);
      onLog?.(`讀取 ${label}（${file.size} bytes）…`);

      const bytes = await readBytes(file);
      const name = `in${i}.${extFromName(file.name)}`;
      await ff.writeFile(name, bytes);
      written.push(name);
      onLog?.(`已寫入 MEMFS：${name}`);
    }

    if (files.length === 1) {
      onStatus?.('轉檔中…');
      await normalizeClip(ff, written[0], 'output.mp4', onLog);
    } else {
      const normalized = [];
      const inputCount = files.length;
      for (let i = 0; i < inputCount; i++) {
        onStatus?.(`標準化第 ${i + 1} / ${inputCount} 段…`);
        const out = `norm${i}.mp4`;
        await normalizeClip(ff, written[i], out, onLog);
        normalized.push(out);
        written.push(out);
      }

      onStatus?.('串接片段…');
      // concat demuxer: no quotes needed inside MEMFS
      const listBody = `${normalized.map((n) => `file ${n}`).join('\n')}\n`;
      await ff.writeFile('list.txt', listBody);
      written.push('list.txt');

      await execOrThrow(
        ff,
        [
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          'list.txt',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-y',
          'output.mp4',
        ],
        onLog,
      );
    }

    onStatus?.('讀取結果…');
    const data = await ff.readFile('output.mp4');
    written.push('output.mp4');

    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!u8.byteLength) {
      throw new Error('合併結果是空檔，請換一段影片再試');
    }
    return new Blob([u8], { type: 'video/mp4' });
  } finally {
    for (const name of written) {
      try {
        await ff.deleteFile(name);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}
