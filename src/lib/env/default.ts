import { createServerOnlyFn } from '@tanstack/react-start';

export const getEnv = createServerOnlyFn(() => {
  return process.env;
});
