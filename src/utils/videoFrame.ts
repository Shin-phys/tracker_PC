// src/utils/videoFrame.ts
// ============================================================
// 「いま画面に出ているフレームの本当の時刻」を得るための道具。
//
// なぜ必要か
//   自動追跡では requestVideoFrameCallback（以下 rVFC）が渡してくる
//   mediaTime をそのまま記録しているので、時刻は常に正確だった。
//   ところが手動トラッキングでは、こちらから
//     video.currentTime += 1 / fps
//   と進めることになる。この「要求した時刻」を記録に使うと、
//   fps の推定値がずれているぶんがそのまま時間軸の誤差になり、
//   しかもコマを進めるたびに積み上がる。
//
//   実際にはブラウザは要求時刻に最も近いフレームへ吸着するので、
//   表示されているフレームの本当の時刻は要求時刻とは違う。
//   そこで「シークしたあと、実際に表示されたフレームの mediaTime を読む」。
//   こうすると fps の推定は「どのコマに着地するか」だけを決め、
//   記録される時刻には一切影響しなくなる。誤差が毎コマ自己修正される。
//
// rVFC が無いブラウザでは seeked イベント後の currentTime で代用する。
// 精度は落ちるが、少なくとも要求時刻をそのまま信じるよりは実態に近い。
// ============================================================

/** このブラウザが requestVideoFrameCallback を持っているか */
export const hasRvfc = (): boolean =>
  typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/**
 * seeked が来てから rVFC を待つ猶予 [ms]。
 * これを過ぎたら currentTime で確定する。
 * 長くするとコマ送りが重くなり、短くすると mediaTime を取り逃す。
 */
const GRACE_MS = 80;

/** rVFC が渡してくるメタデータのうち、ここで使う分だけ */
interface FrameMeta {
  mediaTime?: number;
}

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * 指定した時刻へシークし、**実際に表示されたフレームの時刻**を返す。
 *
 * @param video   対象の video 要素
 * @param target  シークしたい時刻 [s]（動画の範囲へ丸める）
 * @param timeoutMs 応答が無いときに諦めるまでの時間
 * @param graceMs seeked のあと rVFC を待つ猶予。ここで待ち切れないと
 *                「実フレーム時刻」ではなく「要求した時刻」で確定してしまい、
 *                記録される時刻が 1 コマ未満ずれる。コマ送りのように
 *                手応えが要る場面では短く、全コマ処理のように
 *                精度が優先される場面では長く取る
 * @returns 表示されたフレームの mediaTime [s]
 *
 * 注意: 再生中は rVFC が毎フレーム発火して別のコマを掴んでしまうので、
 *       必ず一時停止してから呼ぶ（この関数の中でも念のため止める）。
 */
export function seekToFrameTime(
  video: HTMLVideoElement,
  target: number,
  timeoutMs = 600,
  graceMs = GRACE_MS
): Promise<number> {
  const v = video as RvfcVideo;

  return new Promise<number>((resolve) => {
    if (!v.paused) v.pause();

    const duration = isFinite(v.duration) ? v.duration : 0;
    const t = Math.max(0, duration > 0 ? Math.min(duration, target) : Math.max(0, target));

    let settled = false;
    let handle: number | null = null;
    let timer: number | null = null;

    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      if (handle !== null && v.cancelVideoFrameCallback) {
        try { v.cancelVideoFrameCallback(handle); } catch { /* noop */ }
      }
      v.removeEventListener('seeked', onSeeked);
    };

    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(isFinite(value) ? value : t);
    };

    function onSeeked() {
      // rVFC が無い環境ではこれが本命なので即決める。
      if (!v.requestVideoFrameCallback) {
        finish(v.currentTime);
        return;
      }
      // rVFC がある環境でも、フレームが再提示されずに発火しないことがある。
      // その場合に全体のタイムアウト（既定 600ms）まで待つと、
      // コマ送りが 1 回ごとに固まって手動トラッキングに使えない。
      // seeked が来た時点で短い猶予だけ与え、来なければ currentTime で確定する。
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => finish(v.currentTime), graceMs);
    }

    // rVFC は currentTime を書く前に登録する。
    // 後から登録すると、シークで提示されたフレームを取り逃すことがある。
    if (v.requestVideoFrameCallback) {
      handle = v.requestVideoFrameCallback((_now, meta) => {
        finish(typeof meta?.mediaTime === 'number' ? meta.mediaTime : v.currentTime);
      });
    }
    v.addEventListener('seeked', onSeeked);

    // 応答が無くても必ず解決させる。ここで固まるとコマ送りが効かなくなる
    timer = window.setTimeout(() => finish(v.currentTime), timeoutMs);

    // 同じ時刻を指定すると seeked が発火しないブラウザがあるため、
    // 変化が無いときは即座に現在時刻で確定させる
    if (Math.abs(v.currentTime - t) < 1e-9) {
      // rVFC は登録済みなので、来ればそちらが優先される。
      // 来なければこのタイマーで現在時刻に落ち着く
      timer = window.setTimeout(() => finish(v.currentTime), 60);
      return;
    }

    v.currentTime = t;
  });
}

/**
 * 現在のフレームから n コマ進む／戻る。
 *
 * 起点に「要求した時刻」ではなく **前回実際に表示された時刻** を使うので、
 * fps が多少ずれていても誤差が積み上がらない。
 *
 * @param fps ファイルのフレームレート（自動計測値）
 * @param n   進めるコマ数（負なら戻る）
 * @returns 移動後に表示されたフレームの時刻 [s]
 */
export function stepFrames(
  video: HTMLVideoElement,
  fps: number,
  n: number
): Promise<number> {
  const dt = 1 / (fps > 0 ? fps : 30);
  // 半コマ分ずらして狙う。境界ぴったりを指定すると、
  // 丸めの向きしだいで同じコマに留まることがある
  const target = video.currentTime + n * dt + Math.sign(n) * dt * 0.25;
  return seekToFrameTime(video, target);
}

/**
 * ファイルのフレームレートを、**シークして**実測する。
 *
 * なぜ再生から測らないか
 *   以前は短く再生して rVFC の mediaTime 間隔から測っていたが、
 *   実測で真値のちょうど半分が出た（QuickTime のエンコード FPS 30.03 に対して 15）。
 *   再生中の rVFC は「画面に提示されたフレーム」しか拾わないため、
 *   コールバックの登録タイミング次第で 1 枚おきになりうるし、
 *   そもそも画面のリフレッシュレートを超えて拾えない
 *   （240fps のファイルを 60Hz の画面で測ると 60 が上限になる）。
 *   時間軸の換算はこの値を分子に持つので、半分になると速度も半分になる。
 *
 * 代わりに、一時停止したまま少しずつシークして
 * 「mediaTime が変化した幅」を実フレーム間隔とする。
 * 表示のレートにも登録タイミングにも影響されない。
 *
 * @returns 実測できた fps。できなければ null（呼び出し側は既定値のままにする）
 */
export async function measureFileFps(
  video: HTMLVideoElement,
  samples = 3
): Promise<number | null> {
  const v = video as RvfcVideo;
  const duration = isFinite(v.duration) ? v.duration : 0;
  if (!(duration > 0)) return null;

  const restore = v.currentTime;
  const wasPaused = v.paused;
  v.pause();

  const intervals: number[] = [];

  // 動画の別々の場所で測る。可変フレームレートでも代表値が取れるように
  const probePoints = [duration * 0.2, duration * 0.5, duration * 0.75]
    .slice(0, Math.max(1, samples));

  for (const start of probePoints) {
    const base = await seekToFrameTime(v, start);
    let found = 0;
    // 1ms から倍々に広げ、コマが変わった最初の幅を採る。
    // 1/1000 秒から始めれば 1000fps まで拾える
    for (let stepMs = 1; stepMs <= 256; stepMs *= 2) {
      const t = await seekToFrameTime(v, base + stepMs / 1000);
      if (t > base + 1e-6) { found = t - base; break; }
    }
    if (found > 0.0005 && found < 1) intervals.push(found);
  }

  await seekToFrameTime(v, restore).catch(() => undefined);
  if (!wasPaused) { try { await v.play(); } catch { /* noop */ } }

  if (intervals.length === 0) return null;
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  const fps = Math.round((1 / median) * 100) / 100;
  return fps > 1 && fps < 1000 ? fps : null;
}

/**
 * ファイルのフレームレートを、短く再生して実測する。
 *
 * @deprecated 真値の半分が出ることがある（上の measureFileFps を使うこと）。
 * 再生中の rVFC は提示されたフレームしか拾えず、画面のリフレッシュレートに縛られる。
 *
 * 自動計測は再生中の rVFC 間隔から行っているので、
 * 一度も再生せずにコマ送りを始める使い方（手動トラッキング）では
 * 既定値 30 のまま走ってしまう。読み込み直後に一度だけこれを呼ぶ。
 *
 * @returns 実測できた fps。できなければ null（呼び出し側は既定値のままにする）
 */
export async function probeFileFps(
  video: HTMLVideoElement,
  minSamples = 8,
  timeoutMs = 1500
): Promise<number | null> {
  const v = video as RvfcVideo;
  if (!v.requestVideoFrameCallback) return null;

  const restoreTime = v.currentTime;
  const restoreMuted = v.muted;
  const wasPaused = v.paused;

  try {
    v.muted = true;
    await v.play();
  } catch {
    // 自動再生が拒否された場合は諦める。
    // 通常の再生時に既存の自動計測が働くので実害はない
    v.muted = restoreMuted;
    return null;
  }

  const gaps: number[] = await new Promise((resolve) => {
    const out: number[] = [];
    let prev: number | null = null;
    let handle: number | null = null;
    let done = false;

    const stop = () => {
      if (done) return;
      done = true;
      if (handle !== null && v.cancelVideoFrameCallback) {
        try { v.cancelVideoFrameCallback(handle); } catch { /* noop */ }
      }
      resolve(out);
    };

    const timer = window.setTimeout(stop, timeoutMs);

    const tick = (_now: number, meta: FrameMeta) => {
      const t = typeof meta?.mediaTime === 'number' ? meta.mediaTime : v.currentTime;
      if (prev !== null) {
        const d = t - prev;
        // 明らかな外れ値（停止・シーク・重複フレーム）は捨てる
        if (d > 0.0005 && d < 1) out.push(d);
      }
      prev = t;
      if (out.length >= minSamples) {
        window.clearTimeout(timer);
        stop();
        return;
      }
      if (!done && v.requestVideoFrameCallback) {
        handle = v.requestVideoFrameCallback(tick);
      }
    };

    handle = v.requestVideoFrameCallback!(tick);
  });

  v.pause();
  v.muted = restoreMuted;
  // 計測のために動かしたぶんを戻す。位置が変わったままだと
  // 「読み込んだのに頭出しされていない」ように見える
  await seekToFrameTime(v, restoreTime).catch(() => undefined);
  if (!wasPaused) {
    try { await v.play(); } catch { /* noop */ }
  }

  if (gaps.length < 3) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return null;
  const fps = Math.round((1 / median) * 1000) / 1000;
  return fps > 1 && fps < 1000 ? fps : null;
}
