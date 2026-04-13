import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { systemAdminMiddleware } from './middleware';

export const searchUsersFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .inputValidator(zodValidator(z.object({ query: z.string().min(2) })))
  .handler(async ({ context, data }) => {
    return context.adminScopedDb.admin.searchUsers(data.query);
  });

export const getAdminSequencesFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .inputValidator(zodValidator(z.object({ teamId: ulidSchema })))
  .handler(async ({ context, data }) => {
    return context.adminScopedDb.admin.getSequencesForTeam(data.teamId);
  });

export const getAdminFramesFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context, data }) => {
    return context.adminScopedDb.admin.getFramesForSequence(data.sequenceId);
  });
