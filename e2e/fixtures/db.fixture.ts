/**
 * Database Fixture for E2E Tests
 * Utilities for resetting and seeding test data
 */

/**
 * Clean all test data from the database
 * Called before test suite to ensure clean state
 */
export async function cleanTestData(): Promise<void> {
  await fetch('http://localhost:3001/api/test/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'test-data' }),
  });
}

/**
 * Reset the entire test database
 * Use sparingly - prefer cleanTestData for faster cleanup
 */
export async function resetTestDatabase(): Promise<void> {
  await fetch('http://localhost:3001/api/test/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'full-reset' }),
  });
}
