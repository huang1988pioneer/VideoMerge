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
 * Normalize one clip to H.264 1280x720 @ 30fps (optional AAC audio).
 * @param {FFmpeg} ff
 * @param {string} input
 * @param {string} output
 * @param {{ noAudio?: boolean, onLog?: (msg: string) => void }} [opts]
 */
async function normalizeClip(ff, input, output, opts = {}) {
  const { noAudio = false, onLog } = opts;
  const vf =
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p';

  const videoArgs = [
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
  ];

  if (noAudio) {
    await execOrThrow(ff, [...videoArgs, '-an', '-y', output], onLog);
    return;
  }

  try {
    await execOrThrow(
      ff,
      [
        ...videoArgs,
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
    await execOrThrow(ff, [...videoArgs, '-an', '-y', output], onLog);
  }
}

/** Soft limits to avoid browser OOM (still effectively “extend as needed”). */
export const LOOP_LIMITS = {
  maxCount: 999,
  maxDurationSec: 2 * 60 * 60, // 2 hours
};

/**
 * Concat multiple MEMFS files into one (stream copy).
 * @param {FFmpeg} ff
 * @param {string[]} names
 * @param {string} output
 * @param {(msg: string) => void} [onLog]
 * @param {string[]} written
 */
async function concatCopy(ff, names, output, onLog, written) {
  if (names.length === 1) {
    // Copy single file to output name via remux
    await execOrThrow(
      ff,
      ['-i', names[0], '-c', 'copy', '-movflags', '+faststart', '-y', output],
      onLog,
    );
    return;
  }
  const listName = `list_${Date.now().toString(36)}.txt`;
  const listBody = `${names.map((n) => `file ${n}`).join('\n')}\n`;
  await ff.writeFile(listName, listBody);
  written.push(listName);
  await execOrThrow(
    ff,
    [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listName,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-y',
      output,
    ],
    onLog,
  );
}

/**
 * Loop base clip by count and/or trim to target duration.
 * @param {FFmpeg} ff
 * @param {string} baseName
 * @param {{
 *   mode: 'once' | 'count' | 'duration',
 *   count?: number,
 *   targetSeconds?: number,
 *   baseDurationSec?: number,
 * }} loop
 * @param {(msg: string) => void} [onLog]
 * @param {(status: string) => void} [onStatus]
 * @param {string[]} written
 */
/**
 * Encode args for trim/loop re-encode (respect noAudio).
 * @param {boolean} noAudio
 */
function reencodeTailArgs(noAudio) {
  const args = [
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
  ];
  if (noAudio) {
    args.push('-an');
  } else {
    args.push('-c:a', 'aac', '-b:a', '128k');
  }
  args.push('-movflags', '+faststart', '-y', 'output.mp4');
  return args;
}

/**
 * @param {FFmpeg} ff
 * @param {string} baseName
 * @param {{
 *   mode: 'once' | 'count' | 'duration',
 *   count?: number,
 *   targetSeconds?: number,
 *   baseDurationSec?: number,
 *   noAudio?: boolean,
 * }} loop
 * @param {(msg: string) => void} [onLog]
 * @param {(status: string) => void} [onStatus]
 * @param {string[]} written
 */
async function applyLoopExtend(ff, baseName, loop, onLog, onStatus, written) {
  const mode = loop?.mode || 'once';
  const noAudio = Boolean(loop?.noAudio);

  if (mode === 'once') {
    if (baseName === 'output.mp4') return;
    await execOrThrow(
      ff,
      ['-i', baseName, '-c', 'copy', '-movflags', '+faststart', '-y', 'output.mp4'],
      onLog,
    );
    return;
  }

  if (mode === 'count') {
    const count = Math.floor(Number(loop.count) || 1);
    if (count < 1) throw new Error('重複次數至少為 1');
    if (count > LOOP_LIMITS.maxCount) {
      throw new Error(`重複次數上限為 ${LOOP_LIMITS.maxCount}`);
    }
    if (count === 1) {
      await applyLoopExtend(
        ff,
        baseName,
        { mode: 'once', noAudio },
        onLog,
        onStatus,
        written,
      );
      return;
    }

    onStatus?.(`循環延長：重複 ${count} 次…`);
    onLog?.(`stream_loop extra=${count - 1}（總播放 ${count} 次）`);

    try {
      // -stream_loop N means N additional loops (total plays = N+1)
      await execOrThrow(
        ff,
        [
          '-stream_loop',
          String(count - 1),
          '-i',
          baseName,
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-y',
          'output.mp4',
        ],
        onLog,
      );
    } catch (err) {
      onLog?.(`stream_loop 失敗，改用 concat 清單：${err?.message || err}`);
      const names = Array.from({ length: count }, () => baseName);
      await concatCopy(ff, names, 'output.mp4', onLog, written);
    }
    return;
  }

  if (mode === 'duration') {
    const target = Number(loop.targetSeconds);
    if (!Number.isFinite(target) || target <= 0) {
      throw new Error('請輸入有效的目標時長（秒）');
    }
    if (target > LOOP_LIMITS.maxDurationSec) {
      throw new Error(
        `目標時長上限為 ${LOOP_LIMITS.maxDurationSec / 3600} 小時（${LOOP_LIMITS.maxDurationSec} 秒）`,
      );
    }

    const baseDur = Number(loop.baseDurationSec);
    if (Number.isFinite(baseDur) && baseDur > 0 && target <= baseDur + 0.05) {
      onStatus?.(`裁切至 ${target.toFixed(1)} 秒…`);
      await execOrThrow(
        ff,
        [
          '-i',
          baseName,
          '-t',
          target.toFixed(3),
          ...reencodeTailArgs(noAudio),
        ],
        onLog,
      );
      return;
    }

    onStatus?.(`循環延長並裁切至 ${formatSec(target)}…`);
    onLog?.(`stream_loop -1 + -t ${target}`);

    try {
      await execOrThrow(
        ff,
        [
          '-stream_loop',
          '-1',
          '-i',
          baseName,
          '-t',
          target.toFixed(3),
          ...reencodeTailArgs(noAudio),
        ],
        onLog,
      );
    } catch (err) {
      onLog?.(`stream_loop 時長模式失敗，改用重複 concat：${err?.message || err}`);
      const unit = Number.isFinite(baseDur) && baseDur > 0 ? baseDur : target;
      const times = Math.max(1, Math.ceil(target / unit));
      if (times > LOOP_LIMITS.maxCount) {
        throw new Error(
          `依時長推算需重複 ${times} 次，超過上限 ${LOOP_LIMITS.maxCount}。請縮短目標時長。`,
        );
      }
      const names = Array.from({ length: times }, () => baseName);
      const looped = 'looped_tmp.mp4';
      await concatCopy(ff, names, looped, onLog, written);
      written.push(looped);
      await execOrThrow(
        ff,
        ['-i', looped, '-t', target.toFixed(3), ...reencodeTailArgs(noAudio)],
        onLog,
      );
    }
    return;
  }

  throw new Error(`未知的延長模式：${mode}`);
}

function formatSec(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(r)}`;
  return `${m}:${pad(r)}`;
}

/**
 * Replace video audio with a custom audio file (mp3 etc).
 * Loops audio if shorter than video; trims to video length if longer.
 * @param {FFmpeg} ff
 * @param {string} videoName
 * @param {string} audioName
 * @param {string} output
 * @param {(msg: string) => void} [onLog]
 */
async function muxCustomAudio(ff, videoName, audioName, output, onLog) {
  // Prefer looped audio + shortest (video ends first → clean length)
  try {
    await execOrThrow(
      ff,
      [
        '-i',
        videoName,
        '-stream_loop',
        '-1',
        '-i',
        audioName,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-b:a',
        '192k',
        '-shortest',
        '-movflags',
        '+faststart',
        '-y',
        output,
      ],
      onLog,
    );
    return;
  } catch (err) {
    onLog?.(`循環音訊失敗，改試單次貼上：${err?.message || err}`);
  }

  await execOrThrow(
    ff,
    [
      '-i',
      videoName,
      '-i',
      audioName,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      '-y',
      output,
    ],
    onLog,
  );
}

/**
 * Merge multiple video Files into one MP4 Blob.
 * @param {File[]} files
 * @param {{
 *   noAudio?: boolean,
 *   audioFile?: File | null,
 *   loop?: {
 *     mode: 'once' | 'count' | 'duration',
 *     count?: number,
 *     targetSeconds?: number,
 *     baseDurationSec?: number,
 *   },
 *   onLog?: (msg: string) => void,
 *   onProgress?: (ratio: number) => void,
 *   onStatus?: (status: string) => void,
 * }} [hooks]
 * @returns {Promise<Blob>}
 */
export async function mergeVideos(files, hooks = {}) {
  if (!files?.length) throw new Error('請至少選擇一段影片');

  const {
    onLog,
    onProgress,
    onStatus,
    noAudio = false,
    audioFile = null,
    loop = { mode: 'once' },
  } = hooks;
  const ff = await ensureFFmpeg(onLog, onProgress);

  // Custom soundtrack replaces original audio; strip during normalize.
  const useCustomAudio = Boolean(audioFile) && !noAudio;
  const stripOriginalAudio = noAudio || useCustomAudio;

  if (noAudio) onLog?.('選項：不要聲音（輸出無音軌）');
  if (useCustomAudio) {
    onLog?.(`選項：自訂音軌 ${audioFile.name}（取代原影片聲音）`);
  }
  if (loop?.mode && loop.mode !== 'once') {
    onLog?.(
      `選項：延長模式=${loop.mode}` +
        (loop.mode === 'count' ? ` count=${loop.count}` : '') +
        (loop.mode === 'duration' ? ` target=${loop.targetSeconds}s` : ''),
    );
  }

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

    let audioMemName = null;
    if (useCustomAudio) {
      onStatus?.(`讀取音訊：${audioFile.name}`);
      const audioBytes = await readBytes(audioFile);
      audioMemName = `bgm.${extFromName(audioFile.name) || 'mp3'}`;
      await ff.writeFile(audioMemName, audioBytes);
      written.push(audioMemName);
      onLog?.(`已寫入音訊：${audioMemName}（${audioFile.size} bytes）`);
    }

    const needsLoop = loop?.mode && loop.mode !== 'once';
    const baseName = 'base.mp4';

    // 1) Normalize every input to shared format
    const normalized = [];
    const inputCount = files.length;
    for (let i = 0; i < inputCount; i++) {
      onStatus?.(
        `標準化第 ${i + 1} / ${inputCount} 段${stripOriginalAudio ? '（無原音）' : ''}…`,
      );
      const out = `norm${i}.mp4`;
      await normalizeClip(ff, written[i], out, {
        noAudio: stripOriginalAudio,
        onLog,
      });
      normalized.push(out);
      written.push(out);
    }

    // 2) Build base sequence (one pass of all clips in order)
    onStatus?.(normalized.length === 1 ? '準備基底片段…' : '串接片段…');
    await concatCopy(ff, normalized, baseName, onLog, written);
    written.push(baseName);

    // 3) Optional loop / duration trim → video-only or with original audio
    // When custom audio is used, keep video silent until mux step.
    const videoOut = useCustomAudio ? 'video_only.mp4' : 'output.mp4';
    if (needsLoop) {
      await applyLoopExtend(
        ff,
        baseName,
        { ...loop, noAudio: stripOriginalAudio },
        onLog,
        onStatus,
        written,
      );
      if (useCustomAudio) {
        // applyLoopExtend always writes output.mp4 — rename for mux
        await execOrThrow(
          ff,
          ['-i', 'output.mp4', '-c', 'copy', '-y', videoOut],
          onLog,
        );
        written.push(videoOut);
      }
    } else {
      onStatus?.(stripOriginalAudio ? '輸出影像中…' : '輸出中…');
      await execOrThrow(
        ff,
        ['-i', baseName, '-c', 'copy', '-movflags', '+faststart', '-y', videoOut],
        onLog,
      );
      written.push(videoOut);
    }
    if (!useCustomAudio) written.push('output.mp4');

    // 4) Mux custom MP3 / audio as soundtrack
    if (useCustomAudio && audioMemName) {
      onStatus?.('套用自訂音軌（MP3）…');
      await muxCustomAudio(ff, videoOut, audioMemName, 'output.mp4', onLog);
      written.push('output.mp4');
    }

    onStatus?.('讀取結果…');
    const data = await ff.readFile('output.mp4');

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
