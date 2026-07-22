import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let ffmpeg = null;
let loadPromise = null;

const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

/**
 * Lazy-load ffmpeg.wasm (single-thread core for broad browser support).
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
    const instance = new FFmpeg();
    if (onLog) instance.on('log', ({ message }) => onLog(message));
    if (onProgress) instance.on('progress', ({ progress }) => onProgress(progress));

    await instance.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpeg = instance;
    return instance;
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
  return (m?.[1] || 'mp4').toLowerCase();
}

/**
 * Merge multiple video Files into one MP4 Blob (re-encode for codec safety).
 * @param {File[]} files - ordered clips
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
    onStatus?.('寫入暫存檔…');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = extFromName(file.name);
      const name = `in${i}.${ext}`;
      await ff.writeFile(name, await fetchFile(file));
      written.push(name);
    }

    if (files.length === 1) {
      onStatus?.('轉檔中…');
      await ff.exec([
        '-i',
        written[0],
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-y',
        'output.mp4',
      ]);
    } else {
      // Normalize each clip so concat is reliable across codecs / sizes / audio.
      const normalized = [];
      for (let i = 0; i < written.length; i++) {
        onStatus?.(`標準化第 ${i + 1} / ${written.length} 段…`);
        const out = `norm${i}.mp4`;
        try {
          await ff.exec([
            '-i',
            written[i],
            '-vf',
            'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p',
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
            out,
          ]);
        } catch {
          // Fallback: video only (clips without audio tracks)
          await ff.exec([
            '-i',
            written[i],
            '-vf',
            'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '23',
            '-an',
            '-y',
            out,
          ]);
        }
        normalized.push(out);
        written.push(out);
      }

      onStatus?.('串接片段…');
      const listBody = normalized.map((n) => `file '${n}'`).join('\n');
      await ff.writeFile('list.txt', listBody);
      written.push('list.txt');

      await ff.exec([
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
      ]);
    }

    onStatus?.('讀取結果…');
    const data = await ff.readFile('output.mp4');
    written.push('output.mp4');
    // data is Uint8Array; pass the view itself so we don't include spare ArrayBuffer bytes
    return new Blob([data], { type: 'video/mp4' });
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
