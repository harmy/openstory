import { describe, expect, it } from 'vitest';
import { enhanceSseResponse } from './enhance';

/** Drain an SSE Response body to its decoded text. */
async function readSse(res: Response): Promise<string> {
  return new Response(res.body).text();
}

/** A generator that yields the given deltas, then optionally throws. */
async function* deltas(
  values: string[],
  throwAt?: number
): AsyncGenerator<{ delta: string }> {
  let i = 0;
  for (const delta of values) {
    if (throwAt === i++) throw new Error('mid-stream boom');
    yield { delta };
  }
}

describe('enhanceSseResponse', () => {
  it('streams delta frames then a terminal done frame with the full script', async () => {
    const gen = deltas(['INT. ', 'LIGHTHOUSE', ' - NIGHT  ']);
    const first = await gen.next();
    const res = enhanceSseResponse(first, gen);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(
      'text/event-stream; charset=utf-8'
    );

    const body = await readSse(res);
    expect(body).toContain('data: {"delta":"INT. "}\n\n');
    expect(body).toContain('data: {"delta":"LIGHTHOUSE"}\n\n');

    // The done frame carries the trimmed, concatenated script plus the HAL
    // affordance catalog every v1 response exposes.
    const doneFrame = body
      .split('\n\n')
      .find((frame) => frame.startsWith('event: done'));
    expect(doneFrame).toBeDefined();
    const donePayload = JSON.parse(
      (doneFrame ?? '').replace('event: done\ndata: ', '')
    );
    expect(donePayload.enhancedScript).toBe('INT. LIGHTHOUSE - NIGHT');
    expect(donePayload._links.self.href).toBe('/api/v1/scripts/enhance');
    expect(donePayload._links.root.href).toBe('/api/v1');
    const createLink = donePayload._links['create-sequence'];
    expect(createLink.href).toBe('/api/v1/sequences');
    expect(createLink.method).toBe('POST');
    expect(createLink.contentType).toBe('application/json');
    // The create affordance is ready-to-POST: it embeds the enhanced script
    // with enhancement disabled (the script is already enhanced).
    expect(createLink.examples).toEqual([
      { script: 'INT. LIGHTHOUSE - NIGHT', enhance: 'off' },
    ]);
  });

  it('emits an error frame when the generator fails mid-stream', async () => {
    const gen = deltas(['partial ', 'never'], 1); // yields one delta, then throws
    const first = await gen.next();
    const body = await readSse(enhanceSseResponse(first, gen));

    expect(body).toContain('data: {"delta":"partial "}\n\n');
    expect(body).toContain('event: error');
    expect(body).not.toContain('event: done');
  });
});
