/**
 * BetterAuth configuration for OpenStory
 * Replaces Supabase Auth with anonymous users and email/password login
 */

import { generateId } from '@/lib/db/id';
import {
  account,
  apikey,
  passkey,
  session,
  user,
  verification,
} from '@/lib/db/schema';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, lastLoginMethod } from 'better-auth/plugins';
import { tanstackStartCookies } from 'better-auth/tanstack-start';

import { getDb } from '#db-client';
import { getEnv } from '#env';
import { teamMembers, teams } from '@/lib/db/schema';
import { sendOtpEmail } from '@/lib/services/email-service';
import { apiKey } from '@better-auth/api-key';
import { passkey as passkeyPlugin } from '@better-auth/passkey';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'auth', 'config']);
const betterAuthLogger = getLogger(['openstory', 'auth', 'better-auth']);

// Singleton auth instance cache
let _authInstance: ReturnType<typeof createAuth> | undefined;

/**
 * Create Better Auth instance
 * Separated for type inference - the return type is used for the singleton cache
 */
function createAuth() {
  const runtimeEnv = getEnv();

  return betterAuth({
    // Route Better Auth's own logs through LogTape so they land in the same
    // sink as the rest of the app (PostHog via Cloudflare destination, with
    // category `openstory.auth.better-auth`).
    logger: {
      level: 'warn',
      log: (level, message, ...args) => {
        const props = args.length > 0 ? { args } : {};
        switch (level) {
          case 'error':
            betterAuthLogger.error(message, props);
            break;
          case 'warn':
            betterAuthLogger.warn(message, props);
            break;
          case 'info':
            betterAuthLogger.info(message, props);
            break;
          default:
            betterAuthLogger.debug(message, props);
        }
      },
    },
    database: drizzleAdapter(getDb(), {
      provider: 'sqlite',
      schema: {
        user: user,
        session: session,
        account: account,
        verification: verification,
        passkey: passkey,
        apikey: apikey,
      },
    }),
    secret: runtimeEnv.BETTER_AUTH_SECRET,
    trustedOrigins: [
      'http://localhost:*',
      'http://192.168.*:*',
      'http://100.*:*',
    ],

    // Session configuration
    // SECURITY: 90-day expiration mitigates:
    // - Session fixation attacks
    // - Database bloat from long-lived sessions
    // - GDPR compliance concerns
    session: {
      expiresIn: 60 * 60 * 24 * 90, // 90 days
      updateAge: 60 * 60 * 24, // Update session daily
    },

    // Account linking configuration
    // Allows users to link multiple authentication methods to one account
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'email-otp'],
        allowDifferentEmails: false, // Only link accounts with matching emails
      },
    },

    // Social providers
    // Google OAuth enabled on all environments via oAuthProxy plugin
    // Preview branches proxy OAuth requests to production
    socialProviders: {
      google: {
        clientId: runtimeEnv.GOOGLE_CLIENT_ID,
        clientSecret: runtimeEnv.GOOGLE_CLIENT_SECRET,
        enabled: true,
        overrideUserInfoOnSignIn: true,
      },
    },

    // Configure plugins
    plugins: [
      // Email OTP authentication (passwordless)
      emailOTP({
        otpLength: 6,
        expiresIn: 300, // 5 minutes
        async sendVerificationOTP({ email, otp, type }) {
          if (type === 'sign-in') {
            logger.info('Sending sign-in OTP', { email });
            const result = await sendOtpEmail(email, otp);
            if (!result.success) {
              logger.error('Failed to send OTP:', { data: result.error });
              throw new Error('Failed to send verification code');
            }
            logger.info('OTP sent successfully');
          }
        },
      }),
      lastLoginMethod(),
      passkeyPlugin(),
      // Public-API authentication. `enableSessionForAPIKeys` makes the plugin
      // resolve a full session for the key's owner whenever a request carries a
      // key header — so the existing `getSession`/`requireUser` path works
      // transparently for `/api/v1/*` without any bespoke key-hashing. Keys are
      // prefixed `osk_` (OpenStory Key) and resolve to the creating user via
      // `referenceId`; the team is derived downstream via `resolveUserTeam`.
      apiKey({
        enableSessionForAPIKeys: true,
        defaultKeyLength: 64,
        // Per-key rate limit: 10 requests/second. Enforced on every `/api/v1`
        // request (via the session-from-key validation), stored per key. This
        // is the abuse throttle, sized to comfortably allow normal create +
        // status-poll traffic (incl. parallel per-sequence polls); per-team
        // *cost* is separately bounded by the credit pre-flight in
        // `createSequences`.
        rateLimit: {
          enabled: true,
          maxRequests: 10,
          timeWindow: 1000,
        },
        // Accept either `x-api-key: <key>` or the conventional
        // `Authorization: Bearer <key>` header.
        customAPIKeyGetter: (ctx) => {
          const authHeader = ctx.headers?.get('authorization');
          if (authHeader?.startsWith('Bearer ')) {
            return authHeader.slice('Bearer '.length).trim();
          }
          return ctx.headers?.get('x-api-key') ?? null;
        },
      }),
      // TanStack Start cookie integration - must be after all plugins that set cookies
      // (emailOTP, passkey, lastLoginMethod)
      tanstackStartCookies(),
    ],

    // Custom user fields to match existing schema, This is BetterAuth user table.
    user: {
      additionalFields: {
        status: {
          type: 'string',
          required: false,
          defaultValue: 'active' as const,
        },
      },
    },

    // Create a default team when a new user signs up
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const db = getDb();
            const teamName = user.name
              ? `${user.name}'s Team`
              : `Team ${user.id.slice(0, 8)}`;
            const teamSlug = `team-${user.id.slice(0, 8)}`;

            const [team] = await db
              .insert(teams)
              .values({ name: teamName, slug: teamSlug })
              .returning();

            if (!team) {
              throw new Error(
                `Failed to create default team for user ${user.id}`
              );
            }

            await db.insert(teamMembers).values({
              teamId: team.id,
              userId: user.id,
              role: 'owner',
            });
          },
        },
      },
    },

    // Advanced configuration
    advanced: {
      database: {
        // Generate ULID for user IDs (time-ordered, better performance)
        generateId: () => generateId(),
      },
    },
  });
}

/**
 * Get or create Better Auth instance (singleton)
 * Compatible with Cloudflare Workers where env is request-scoped
 */
export function getAuth() {
  return (_authInstance ??= createAuth());
}
// Type inference for the auth instance with custom fields
export type Auth = ReturnType<typeof getAuth>;
export type Session = ReturnType<typeof getAuth>['$Infer']['Session'];
export type User = ReturnType<typeof getAuth>['$Infer']['Session']['user'];
