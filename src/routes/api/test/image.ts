import { createFileRoute } from '@tanstack/react-router';
import { deflateSync } from 'node:zlib';
import { testOnlyGuard } from './route';

/** Generate a minimal valid PNG with a solid color gradient (purple tones). */
function generatePng(w: number, h: number): Buffer {
  // Build raw pixel data: each row starts with filter byte 0 (None)
  const rowBytes = 1 + w * 3; // filter + RGB per pixel
  const raw = Buffer.alloc(rowBytes * h);

  for (let y = 0; y < h; y++) {
    const offset = y * rowBytes;
    raw[offset] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      const px = offset + 1 + x * 3;
      // Simple gradient: purple top-left to violet bottom-right
      const t = (x / Math.max(w - 1, 1) + y / Math.max(h - 1, 1)) / 2;
      raw[px] = Math.round(79 + t * 45); // R: 79-124
      raw[px + 1] = Math.round(70 - t * 12); // G: 70-58
      raw[px + 2] = Math.round(229 + t * 8); // B: 229-237
    }
  }

  const compressed = deflateSync(raw);

  // PNG file structure
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = pngChunk(
    'IHDR',
    (() => {
      const buf = Buffer.alloc(13);
      buf.writeUInt32BE(w, 0);
      buf.writeUInt32BE(h, 4);
      buf[8] = 8; // bit depth
      buf[9] = 2; // color type: RGB
      buf[10] = 0; // compression
      buf[11] = 0; // filter
      buf[12] = 0; // interlace
      return buf;
    })()
  );

  const idat = pngChunk('IDAT', compressed);
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** Build a PNG chunk: length(4) + type(4) + data + crc(4) */
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0);

  return Buffer.concat([length, typeBytes, data, crc]);
}

/** CRC-32 for PNG chunks */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === undefined) continue;
    c ^= byte;
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return c ^ 0xffffffff;
}

export const Route = createFileRoute('/api/test/image')({
  server: {
    middleware: [testOnlyGuard],
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        // Cap at 100px to keep generation fast — dimensions don't matter for e2e
        const w = Math.min(Number(url.searchParams.get('w')) || 9, 100);
        const h = Math.min(Number(url.searchParams.get('h')) || 9, 100);

        const png = generatePng(w, h);

        return new Response(new Uint8Array(png), {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      },
    },
  },
});
