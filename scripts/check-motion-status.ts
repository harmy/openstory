#!/usr/bin/env bun
/**
 * CLI helper script to check motion generation status
 *
 * Usage:
 *   bun scripts/check-motion-status.ts <status-url>
 *   bun scripts/check-motion-status.ts --result <response-url>
 *   bun scripts/check-motion-status.ts --cancel <cancel-url>
 *
 * Examples:
 *   bun scripts/check-motion-status.ts https://queue.fal.run/fal-ai/fast-svd-lcm/requests/abc123/status
 *   bun scripts/check-motion-status.ts --result https://queue.fal.run/fal-ai/fast-svd-lcm/requests/abc123
 *   bun scripts/check-motion-status.ts --cancel https://queue.fal.run/fal-ai/fast-svd-lcm/requests/abc123/cancel
 */

import {
  checkMotionStatus,
  getMotionResult,
  cancelMotionGeneration,
} from '../src/lib/motion/motion-generation';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Error: No URL provided');
  console.log('');
  console.log('Usage:');
  console.log('  bun scripts/check-motion-status.ts <status-url>');
  console.log('  bun scripts/check-motion-status.ts --result <response-url>');
  console.log('  bun scripts/check-motion-status.ts --cancel <cancel-url>');
  console.log('');
  console.log('Examples:');
  console.log(
    '  bun scripts/check-motion-status.ts https://queue.fal.run/fal-ai/fast-svd-lcm/requests/abc123/status'
  );
  console.log(
    '  bun scripts/check-motion-status.ts --result https://queue.fal.run/fal-ai/fast-svd-lcm/requests/abc123'
  );
  console.log(
    '  bun scripts/check-motion-status.ts --cancel https://queue.fal.run/fal-ai/fast-svd-lcm/requests/abc123/cancel'
  );
  process.exit(1);
}

async function main() {
  try {
    const mode = args[0];

    if (mode === '--result') {
      if (args.length < 2) {
        console.error('Error: No response URL provided');
        process.exit(1);
      }

      const responseUrl = args[1];
      console.log(`Fetching result from: ${responseUrl}`);
      const result = await getMotionResult(responseUrl);
      console.log('Result:', JSON.stringify(result, null, 2));
    } else if (mode === '--cancel') {
      if (args.length < 2) {
        console.error('Error: No cancel URL provided');
        process.exit(1);
      }

      const cancelUrl = args[1];
      console.log(`Canceling request: ${cancelUrl}`);
      await cancelMotionGeneration(cancelUrl);
      console.log('Request canceled successfully');
    } else {
      // Default: check status
      const statusUrl = args[0];
      console.log(`Checking status: ${statusUrl}`);
      const status = await checkMotionStatus(statusUrl);
      console.log('Status:', JSON.stringify(status, null, 2));

      // Show interpretation
      console.log('');
      console.log('Interpretation:');
      if (status.status === 'IN_QUEUE') {
        console.log(
          `⏳ Request is in queue at position ${status.queue_position}`
        );
      } else if (status.status === 'IN_PROGRESS') {
        console.log('🔄 Generation in progress...');
        if (status.logs && status.logs.length > 0) {
          console.log('\nLogs:');
          status.logs.forEach((log) => {
            console.log(`  [${log.level}] ${log.message}`);
          });
        }
      } else {
        console.log('✅ Generation completed!');
        if (status.metrics?.inference_time) {
          console.log(
            `   Inference time: ${status.metrics.inference_time.toFixed(2)}s`
          );
        }
        console.log(`\nGet result with:`);
        console.log(
          `  bun scripts/check-motion-status.ts --result ${status.response_url}`
        );
      }
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

void main();
