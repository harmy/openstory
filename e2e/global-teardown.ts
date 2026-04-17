import { stopAimockServer } from './mocks/aimock-server';

/**
 * Playwright global teardown - stops the aimock server after all tests complete.
 */
export default async function globalTeardown() {
  await stopAimockServer();
}
