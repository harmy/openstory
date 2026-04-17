import { createServerFn } from '@tanstack/react-start';
import { systemAdminMiddleware } from './middleware';

export const listUserActivityFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .handler(async ({ context }) => {
    return context.adminScopedDb.admin.listUserActivity();
  });
