import { stopAimockServer } from './mocks/aimock-server';
import { stopR2MockServer } from './mocks/r2-mock-server';

/**
 * Playwright global teardown - stops aimock + r2-mock after all tests complete.
 */
export default async function globalTeardown() {
  await stopAimockServer();
  await stopR2MockServer();
}
