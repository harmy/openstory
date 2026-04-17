import { getRealtime } from '@/lib/realtime';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authMiddleware } from './middleware';

const channelInputSchema = z.object({ channel: z.string().min(1) });

/**
 * Fetches all events from an Upstash Realtime channel's history.
 * Used to replay generation progress state after page refresh.
 */
export const getChannelHistoryFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator(zodValidator(channelInputSchema))
  .handler(async ({ data }) => {
    const realtime = getRealtime();
    const messages = await realtime.channel(data.channel).history();

    // Redis streams store field values as strings, so msg.data may already be
    // a JSON string. Normalize each to an object before re-stringifying for
    // transport (TanStack Start server functions reject `unknown` in return types).
    return messages.flatMap((msg) => {
      try {
        const normalizedData =
          typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        return [
          {
            id: msg.id,
            event: msg.event,
            channel: msg.channel,
            data: JSON.stringify(normalizedData),
          },
        ];
      } catch {
        console.error(
          `[realtime-history] Failed to parse message ${msg.id} in channel "${data.channel}"`,
          msg.data
        );
        return [];
      }
    });
  });
