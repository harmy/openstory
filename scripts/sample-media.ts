/**
 * Local media helpers shared by the sample-video scripts — downloading a URL to
 * disk and concatenating per-frame clips into one mp4. The OpenStory platform
 * has no server-side assembly (final export is client-side), so any script that
 * turns a sequence into a single file does the concat here.
 *
 * Script-only (node fs + ffmpeg); never imported by the app, so nothing here
 * ships in the worker bundle. Used by both `generate-style-sample-videos.ts`
 * (renders new sequences) and `pull-account-sample-videos.ts` (harvests
 * existing ones).
 */

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Fetch `url` and write its bytes to `dest`. Throws on a non-2xx response. */
export async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Concatenate clips into one mp4. Stream-copy first, re-encode on failure. */
export async function concatClips(
  clipPaths: string[],
  outputPath: string
): Promise<void> {
  const listFile = path.join(
    path.dirname(clipPaths[0] ?? outputPath),
    'concat.txt'
  );
  const list = clipPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  await writeFile(listFile, list);
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-c',
      'copy',
      outputPath,
    ]);
  } catch {
    // Codec/params differ across clips — re-encode through the concat filter.
    const inputs = clipPaths.flatMap((p) => ['-i', p]);
    const filter =
      clipPaths.map((_, i) => `[${i}:v:0]`).join('') +
      `concat=n=${clipPaths.length}:v=1:a=0[outv]`;
    await execFileAsync('ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex',
      filter,
      '-map',
      '[outv]',
      outputPath,
    ]);
  }
}
