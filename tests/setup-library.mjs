/**
 * Build a throwaway local library for the browser QA suites.
 *
 * Two series, each with a real cover image so artwork can be asserted, and a
 * third with a deliberately unreadable file:
 *
 *   QA Test Show  - two 5.759s clips. Short on purpose: the autoplay suite
 *                   needs a real end-of-stream quickly.
 *   Long Show     - two copies of the 34.5s clip, past the 20s Continue
 *                   Watching gate, so that gate is exercised for real.
 *   Broken Show   - 2KB of garbage, so the error panel has something honest.
 *
 *   node tests/setup-library.mjs <library-dir>
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node tests/setup-library.mjs <library-dir>');
  process.exit(1);
}

const media = (name) => path.resolve('tests/fixtures/media', name);
const cover = media('cover.png');

function series(name, source, episodes) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const episode of episodes) fs.copyFileSync(source, path.join(dir, episode));
  if (fs.existsSync(cover)) fs.copyFileSync(cover, path.join(dir, 'cover.png'));
  return dir;
}

const short = media('sample.mp4');
const long = media('long.mp4');

console.log(series('QA Test Show', short, ['01 - First Contact.mp4', '02 - Second Contact.mp4']));
if (fs.existsSync(long)) {
  console.log(series('Long Show', long, ['01 - Long One.mp4', '02 - Long Two.mp4']));
}

// Metadata never arrives for this one, so the player must surface its error.
const broken = path.join(root, 'Broken Show');
fs.mkdirSync(broken, { recursive: true });
fs.writeFileSync(path.join(broken, '01 - Corrupt.mp4'), Buffer.alloc(2048, 0x11));