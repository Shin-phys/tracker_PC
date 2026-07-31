#!/usr/bin/env node
// scripts/sync-core.mjs
// ============================================================
// 共通コード（src/utils と src/types）を PC 版からスマホ版へ同期する。
//
// なぜ必要か
//   PC 版（tracker_PC）とスマホ版（tracker_mobile）は UI が別物なので
//   components は共有できないが、utils と types は 1 行も違わない。
//   実際に運用してみると、平滑化の追加・時間軸の換算・型の変更など、
//   まったく同じ変更を 2 回書く場面が繰り返し出てくる。
//   2 回書くと必ずどちらかが古くなるので、片方を正として機械的に配る。
//
// 使い方
//   npm run sync:core        … PC 版 → スマホ版 へコピー
//   npm run sync:core:check  … 差分があれば異常終了（コミット前の確認用）
//
// スマホ版の置き場所
//   既定では PC 版リポジトリの隣（../トレースアプリ_スマホ）を見る。
//   別の場所にあるときは環境変数で指定する:
//     TRACKER_MOBILE_DIR=/path/to/tracker_mobile npm run sync:core
//
// 注意
//   スマホ版の src/utils と src/types は「PC 版のコピー」である。
//   スマホ版側で直接編集しても、次の同期で上書きされる。
//   共通コードを直すときは必ず PC 版を編集すること。
// ============================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 同期するディレクトリ（PC 版リポジトリのルートからの相対） */
const SYNC_DIRS = ['src/utils', 'src/types'];

/**
 * 同期から外すファイル。
 * 片方だけに必要な実装ができたらここに足す（現時点では無し）。
 */
const EXCLUDE = new Set([]);

const CHECK_ONLY = process.argv.includes('--check');

// scripts/ の 1 つ上が PC 版リポジトリのルート
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** スマホ版だけにあるファイル。これでフォルダを見分ける */
const MOBILE_MARKER = 'src/components/VideoStage.tsx';

const exists = async (p) => {
  try { await fs.access(p); return true; } catch { return false; }
};

/**
 * スマホ版リポジトリの場所を決める。
 *
 * フォルダ名を直接書かないのは、日本語名が Unicode 正規化（NFC / NFD）の
 * 違いで一致しないことがあるため。macOS では透過的に扱われるが、
 * Linux（CI など）では別名として扱われて見つからない。
 * そこで「隣のフォルダを中身で見分ける」方式にしている。
 */
const resolveMobileRoot = async () => {
  if (process.env.TRACKER_MOBILE_DIR) {
    return path.resolve(process.env.TRACKER_MOBILE_DIR);
  }
  const parent = path.resolve(SRC_ROOT, '..');
  let entries;
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(parent, e.name);
    if (dir === SRC_ROOT) continue;
    if (await exists(path.join(dir, MOBILE_MARKER))) found.push(dir);
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    console.error('スマホ版の候補が複数見つかりました:');
    found.forEach((d) => console.error(`  ${d}`));
    console.error('TRACKER_MOBILE_DIR でどれを使うか指定してください。');
    process.exit(1);
  }
  return null;
};

const listFiles = async (dir) => {
  const abs = path.join(SRC_ROOT, dir);
  let names;
  try {
    names = await fs.readdir(abs);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.ts') || n.endsWith('.tsx'))
    .filter((n) => !EXCLUDE.has(`${dir}/${n}`))
    .map((n) => `${dir}/${n}`);
};

const read = async (p) => {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
};

const main = async () => {
  // スマホ版が見つからないときは、黙って何もせず終わらない。
  // 「同期したつもり」が一番まずい
  const DST_ROOT = await resolveMobileRoot();
  if (!DST_ROOT || !(await exists(path.join(DST_ROOT, MOBILE_MARKER)))) {
    console.error('スマホ版リポジトリが見つかりません。');
    console.error(`  探した場所: ${path.resolve(SRC_ROOT, '..')} の直下`);
    console.error(`  目印: ${MOBILE_MARKER}`);
    console.error('TRACKER_MOBILE_DIR で場所を指定してください。');
    process.exit(1);
  }

  const files = (await Promise.all(SYNC_DIRS.map(listFiles))).flat();
  if (files.length === 0) {
    console.error('同期対象のファイルが見つかりませんでした。');
    process.exit(1);
  }

  const drifted = [];
  const copied = [];

  for (const rel of files) {
    const srcPath = path.join(SRC_ROOT, rel);
    const dstPath = path.join(DST_ROOT, rel);
    const [src, dst] = await Promise.all([read(srcPath), read(dstPath)]);

    if (src === dst) continue;

    if (CHECK_ONLY) {
      drifted.push({ rel, missing: dst === null });
      continue;
    }

    await fs.mkdir(path.dirname(dstPath), { recursive: true });
    await fs.writeFile(dstPath, src, 'utf8');
    copied.push({ rel, missing: dst === null });
  }

  const total = files.length;

  if (CHECK_ONLY) {
    if (drifted.length === 0) {
      console.log(`共通コードは一致しています（${total} ファイル）`);
      return;
    }
    console.error(`共通コードに差分があります（${drifted.length} / ${total} ファイル）`);
    for (const d of drifted) {
      console.error(`  ${d.missing ? '未作成' : '差分  '}  ${d.rel}`);
    }
    console.error('\nnpm run sync:core で同期してください。');
    process.exit(1);
  }

  if (copied.length === 0) {
    console.log(`同期済み — 変更はありませんでした（${total} ファイル）`);
    return;
  }
  console.log(`スマホ版へ同期しました（${copied.length} / ${total} ファイル）`);
  for (const c of copied) {
    console.log(`  ${c.missing ? '新規' : '更新'}  ${c.rel}`);
  }
  console.log(`\n同期先: ${DST_ROOT}`);
  console.log('スマホ版のビルドも通るか確認してください。');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
