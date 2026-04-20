/**
 * BetterAuth configuration for OpenStory
 * Replaces Supabase Auth with anonymous users and email/password login
 */

import { generateId } from '@/lib/db/id';
import { account, passkey, session, user, verification } from '@/lib/db/schema';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP, lastLoginMethod } from 'better-auth/plugins';
import { tanstackStartCookies } from 'better-auth/tanstack-start';

import { getDb } from '#db-client';
import { getEnv } from '#env';
import { sendOtpEmail } from '@/lib/services/email-service';
import { passkey as passkeyPlugin } from '@better-auth/passkey';
import { teams, teamMembers } from '@/lib/db/schema';

// Singleton auth instance cache
let _authInstance: ReturnType<typeof createAuth> | undefined;

/**
 * Create Better Auth instance
 * Separated for type inference - the return type is used for the singleton cache
 */
function createAuth() {
  const runtimeEnv = getEnv();

  return betterAuth({
    database: drizzleAdapter(getDb(), {
      provider: 'sqlite',
      schema: {
        user: user,
        session: session,
        account: account,
        verification: verification,
        passkey: passkey,
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
      // TanStack Start cookie integration
      tanstackStartCookies(),
      // Email OTP authentication (passwordless)
      emailOTP({
        otpLength: 6,
        expiresIn: 300, // 5 minutes
        async sendVerificationOTP({ email, otp, type }) {
          if (type === 'sign-in') {
            console.log('[BetterAuth] Sending sign-in OTP', { email });
            const result = await sendOtpEmail(email, otp);
            if (!result.success) {
              console.error('[BetterAuth] Failed to send OTP:', result.error);
              throw new Error('Failed to send verification code');
            }
            console.log('[BetterAuth] OTP sent successfully');
          }
        },
      }),
      lastLoginMethod(),
      passkeyPlugin(),
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
