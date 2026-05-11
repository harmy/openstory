#!/usr/bin/env bun
/**
 * Pretty-prints a TanStack Start framed protocol response body for debugging.
 *
 * Usage:
 *   bun scripts/decode-tss-frames.ts <path-to-binary>
 *
 * Get the binary file by saving a server-fn response from Chrome DevTools:
 *   Network tab → right-click request → Save Response As...
 *
 * Protocol (from node_modules/@tanstack/start-client-core/dist/esm/constants.js):
 *   [type:1][streamId:4 big-endian][length:4 big-endian][payload:length]
 *   type 0=JSON, 1=CHUNK, 2=END, 3=ERROR
 */

import { readFileSync } from 'node:fs';

const HEADER_SIZE = 9;
const TYPE_NAMES = ['JSON', 'CHUNK', 'END', 'ERROR'] as const;

const path = process.argv[2];
if (!path) {
  console.error('Usage: bun scripts/decode-tss-frames.ts <path-to-binary>');
  process.exit(1);
}

const buf = readFileSync(path);
console.log(`File: ${path} (${buf.length} bytes)\n`);

let offset = 0;
let frameNum = 0;
while (offset < buf.length) {
  if (buf.length - offset < HEADER_SIZE) {
    console.log(
      `⚠️  Truncated header at offset ${offset}: only ${buf.length - offset} bytes left, need ${HEADER_SIZE}`
    );
    break;
  }
  const type = buf[offset];
  const streamId = buf.readUInt32BE(offset + 1);
  const length = buf.readUInt32BE(offset + 5);
  const typeName = TYPE_NAMES[type] ?? `UNKNOWN(${type})`;
  const payloadStart = offset + HEADER_SIZE;
  const payloadEnd = payloadStart + length;

  console.log(
    `── frame #${frameNum} @ 0x${offset.toString(16).padStart(6, '0')} ── ${typeName} streamId=${streamId} length=${length}`
  );

  if (payloadEnd > buf.length) {
    console.log(
      `⚠️  Truncated payload: header declares ${length} bytes but only ${buf.length - payloadStart} left`
    );
    break;
  }

  const payload = buf.subarray(payloadStart, payloadEnd);

  if (type === 0 /* JSON */) {
    const text = payload.toString('utf-8');
    // seroval emits NDJSON; print each line so frames with multiple lines stay readable
    const lines = text.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        console.log(`   ${JSON.stringify(obj)}`);
      } catch {
        console.log(`   (non-JSON) ${line}`);
      }
    }
  } else if (type === 1 /* CHUNK */) {
    // Raw stream chunks — print as utf-8 if printable, else hex preview
    const text = payload.toString('utf-8');
    const printable = /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text);
    console.log(
      printable
        ? `   ${JSON.stringify(text)}`
        : `   (binary, ${payload.length} bytes, hex preview): ${payload.subarray(0, 64).toString('hex')}${payload.length > 64 ? '…' : ''}`
    );
  } else if (type === 2 /* END */) {
    console.log(`   (stream ${streamId} closed)`);
  } else if (type === 3 /* ERROR */) {
    console.log(`   ${payload.toString('utf-8')}`);
  } else {
    console.log(
      `   (unknown frame type ${type}, hex): ${payload.subarray(0, 32).toString('hex')}${payload.length > 32 ? '…' : ''}`
    );
  }

  offset = payloadEnd;
  frameNum++;
}

console.log(
  `\nDone. ${frameNum} frame(s), consumed ${offset}/${buf.length} bytes.${
    offset !== buf.length
      ? ` ⚠️  ${buf.length - offset} trailing byte(s) unread.`
      : ''
  }`
);
