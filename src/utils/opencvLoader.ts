// src/utils/opencvLoader.ts
import cvModule from '@techstark/opencv-js';

let cvPromise: Promise<any> | null = null;

export const waitForOpenCV = (): Promise<any> => {
  if (cvPromise) return cvPromise;

  cvPromise = new Promise(async (resolve, reject) => {
    try {
      console.log('[OpenCV] @techstark/opencv-js を初期化中...');

      let cv: any = cvModule;

      // default エクスポートへの対応
      if (cv && cv.default) {
        cv = cv.default;
      }

      // Module factory関数への対応
      if (typeof cv === 'function') {
        cv = cv();
      }

      // Promiseへの対応（WASM コンパイル完了を待つ）
      if (cv && typeof cv.then === 'function') {
        cv = await cv;
      }

      // Mat が存在すれば初期化完了
      if (cv && cv.Mat) {
        console.log('[OpenCV] エンジン初期化完了 (Ready)');
        resolve(cv);
        return;
      }

      // onRuntimeInitialized コールバックが必要な場合の対応
      if (cv) {
        cv.onRuntimeInitialized = () => {
          console.log('[OpenCV] Runtime initialized (callback)');
          resolve(cv);
        };

        // ポーリング監視（フォールバック）
        let pollCount = 0;
        const interval = setInterval(() => {
          pollCount++;
          if (cv && cv.Mat) {
            clearInterval(interval);
            console.log('[OpenCV] Ready (polling)');
            resolve(cv);
          }
          if (pollCount > 200) {
            clearInterval(interval);
            reject(new Error('[OpenCV] タイムアウト: 20秒以内に初期化できませんでした'));
          }
        }, 100);
      } else {
        throw new Error('OpenCV モジュールを読み込めませんでした');
      }
    } catch (err) {
      console.error('[OpenCV] 初期化失敗:', err);
      reject(err);
    }
  });

  return cvPromise;
};
