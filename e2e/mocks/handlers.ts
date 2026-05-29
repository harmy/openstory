/**
 * Playwright Route Handlers for E2E Tests
 * Intercepts external API calls (fal.ai, QStash) to return mock responses.
 * R2 traffic is handled server-side by the r2-mock sidecar (port 4011) —
 * see e2e/mocks/r2-mock-server.ts.
 */

import type { Page, Route } from 'playwright/test';

/**
 * Mock image generation response
 */
const mockImageResponse = {
  images: [
    {
      url: 'https://fal.media/files/mock/test-image.png',
      width: 1024,
      height: 1024,
      content_type: 'image/png',
    },
  ],
  timings: { inference: 2.5 },
  seed: 12345,
  has_nsfw_concepts: [false],
  prompt: 'Test prompt',
};

/**
 * Mock motion/video generation response
 */
const mockMotionResponse = {
  video: {
    url: 'https://fal.media/files/mock/test-video.mp4',
    content_type: 'video/mp4',
    file_name: 'output.mp4',
    file_size: 1024000,
  },
  seed: 12345,
};

/**
 * Mock QStash publish response
 */
const mockQStashResponse = {
  messageId: 'mock-message-id-12345',
};

/**
 * Set up route handlers on a page to mock external APIs
 */
export async function setupMockRoutes(page: Page): Promise<void> {
  // Mock fal.ai image generation
  await page.route('**/fal.run/**', async (route: Route) => {
    const url = route.request().url();

    if (url.includes('flux') || url.includes('stable-diffusion')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockImageResponse),
      });
    } else if (
      url.includes('kling') ||
      url.includes('wan') ||
      url.includes('video')
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMotionResponse),
      });
    } else {
      await route.continue();
    }
  });

  // Mock fal.ai queue endpoints
  await page.route('**/queue.fal.run/**', async (route: Route) => {
    const method = route.request().method();

    if (method === 'POST') {
      // Queue submission
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          request_id: 'mock-request-id-12345',
          status_url: 'https://queue.fal.run/mock/status',
          response_url: 'https://queue.fal.run/mock/response',
          cancel_url: 'https://queue.fal.run/mock/cancel',
        }),
      });
    } else if (method === 'GET') {
      // Status check or result fetch
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'COMPLETED',
          ...mockImageResponse,
        }),
      });
    } else {
      await route.continue();
    }
  });

  // Mock QStash publish
  await page.route('**/qstash.upstash.io/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockQStashResponse),
    });
  });

  // Mock upload proxy (used in e2e when getSignedUploadUrl returns proxy URL)
  await page.route('**/api/storage/upload*', async (route: Route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    } else {
      await route.continue();
    }
  });

  // Safety net: redirect any stray picsum.photos requests to local test image endpoint
  await page.route('**/picsum.photos/**', async (route: Route) => {
    await route.fulfill({
      status: 302,
      headers: {
        Location: 'http://localhost:3001/api/test/image?w=9&h=9',
      },
    });
  });

  // R2 traffic note: under the cf-plugin runtime, the browser never PUTs
  // directly to `*.r2.cloudflarestorage.com` — uploads go through the worker
  // (storage-cloudflare.ts), which routes through the r2-mock sidecar on
  // :4011 for fixture replay/record. Image reads via R2_PUBLIC_STORAGE_DOMAIN
  // go straight to real R2 where the bytes were uploaded during recording.
}

/**
 * Create a custom mock response handler
 */
export function createMockHandler(response: unknown) {
  return async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  };
}
