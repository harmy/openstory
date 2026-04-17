/**
 * Server Function Middleware
 * Reusable middleware for authentication, team access, and resource validation
 */

import {
  requireTeamAdminAccess,
  requireTeamMemberAccess,
  requireTeamOwnerAccess,
} from '@/lib/auth/action-utils';
import { getAuth } from '@/lib/auth/config';
import type { Session, User } from '@/lib/auth/config';
import { isSystemAdmin, requireSystemAdmin } from '@/lib/auth/system-admin';
import { isStripeEnabled } from '@/lib/billing/constants';
import { getStripeOrThrow, getStripeWebhookSecret } from '@/lib/billing/stripe';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import {
  createScopedDb,
  createSystemAdminScopedDb,
  getSequenceByIdUnscoped,
  resolveUserTeam,
  type ScopedDb,
} from '@/lib/db/scoped';
import { NotFoundError, OpenStoryError } from '@/lib/errors';
import { emitLog } from '@/lib/observability/structured-log';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import type { Frame, Sequence } from '@/types/database';
import { createMiddleware } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import type Stripe from 'stripe';
import { z } from 'zod';

// ============================================================================
// Context Types
// ============================================================================

export type AuthContext = {
  user: User;
  session: Session;
};

export type TeamContext = AuthContext & {
  teamId: string;
  scopedDb: ScopedDb;
};

export type SystemAdminContext = TeamContext;

export type StripeWebhookContext = {
  stripeEvent: Stripe.Event | null;
  scopedDb: ScopedDb | null;
  teamId: string | null;
  userId: string | null;
};

export type SequenceContext = TeamContext & {
  sequence: Sequence;
};

/**
 * Partial sequence type returned by getFrameWithSequence
 * Contains only the fields selected by the query
 */
type PartialSequence = {
  id: string;
  teamId: string;
  title: string;
  status: string;
  styleId: string | null;
  videoModel: string;
  aspectRatio: AspectRatio;
};

export type FrameContext = TeamContext & {
  frame: Omit<Frame, 'sequence'>;
  sequence: PartialSequence;
};

// ============================================================================
// Logger Middleware
// ============================================================================

/**
 * Request logging middleware - logs server function name, duration, and outcome.
 * All other middleware chains from authMiddleware which chains from this,
 * so every server function gets logging automatically.
 */
const SIZE_WARNING_BYTES = 6 * 1024 * 1024; // 6 MB

export const loggerMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next, serverFnMeta }) => {
    const fnName = serverFnMeta.name;
    const start = performance.now();
    const request = getRequest();
    const contentLength = request.headers.get('content-length');
    const contentLengthNum = contentLength ? Number(contentLength) : undefined;
    const path = new URL(request.url).pathname;

    if (contentLengthNum && contentLengthNum > SIZE_WARNING_BYTES) {
      emitLog({
        level: 'warn',
        source: 'serverFn',
        name: fnName,
        method: request.method,
        path,
        durationMs: 0,
        contentLength: contentLengthNum,
        status: 'ok',
      });
    }

    try {
      const result = await next();
      const durationMs = Math.round(performance.now() - start);
      emitLog({
        level: 'info',
        source: 'serverFn',
        name: fnName,
        method: request.method,
        path,
        durationMs,
        contentLength: contentLengthNum,
        status: 'ok',
      });
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const errorLog =
        error instanceof OpenStoryError
          ? {
              code: error.code,
              message: error.message,
              statusCode: error.statusCode,
            }
          : {
              code: 'UNKNOWN',
              message: error instanceof Error ? error.message : String(error),
            };

      emitLog({
        level: 'error',
        source: 'serverFn',
        name: fnName,
        method: request.method,
        path,
        durationMs,
        contentLength: contentLengthNum,
        status: 'error',
        error: errorLog,
      });
      throw error;
    }
  }
);

// ============================================================================
// Auth Middleware
// ============================================================================

/**
 * Request auth middleware — for use with server routes (server.middleware).
 * Unlike authMiddleware (type: 'function'), this is request-scoped and
 * receives the request object directly from the middleware params.
 */
export const authRequestMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session?.user) {
      throw new Response('Unauthorized', { status: 401 });
    }

    return next({
      context: {
        user: session.user,
        session,
      },
    });
  }
);

/**
 * Request auth + team middleware — for use with server routes (server.middleware).
 * Authenticates user, resolves their default team, and creates a scoped DB.
 * Throws 401 if no user, 403 if no team.
 */
export const authWithTeamRequestMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session?.user) {
      throw new Response('Unauthorized', { status: 401 });
    }

    const team = await resolveUserTeam(session.user.id);

    if (!team) {
      throw new Response('No team found for user', { status: 403 });
    }

    return next({
      context: {
        user: session.user,
        session,
        teamId: team.teamId,
        scopedDb: createScopedDb(team.teamId, session.user.id),
      },
    });
  }
);

/**
 * Stripe webhook signature verification middleware — for use with server routes.
 * Verifies the stripe-signature header and passes the validated event via context.
 * When Stripe is disabled, passes stripeEvent: null so the handler can early-return.
 */
export const stripeWebhookMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    if (!isStripeEnabled()) {
      return next({
        context: {
          stripeEvent: null as Stripe.Event | null,
          scopedDb: null as ScopedDb | null,
          teamId: null as string | null,
          userId: null as string | null,
        },
      });
    }

    const stripe = getStripeOrThrow();
    const webhookSecret = getStripeWebhookSecret();
    if (!webhookSecret) {
      throw Response.json(
        { error: 'Webhook secret not configured' },
        { status: 500 }
      );
    }

    const body = await request.text();
    const signature = request.headers.get('stripe-signature');
    if (!signature) {
      throw Response.json(
        { error: 'Missing stripe-signature header' },
        { status: 400 }
      );
    }

    try {
      const event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        webhookSecret
      );

      const obj = event.data.object;

      if (
        !('metadata' in obj) ||
        typeof obj.metadata !== 'object' ||
        obj.metadata === null
      ) {
        throw new Error(`Stripe event ${event.id} missing metadata`);
      }
      const metadata = obj.metadata;
      if (!('teamId' in metadata && 'userId' in metadata)) {
        throw new Error(
          `Stripe event ${event.id} missing teamId or userId in metadata`
        );
      }

      const teamId = metadata.teamId;
      const userId = metadata.userId;
      if (typeof teamId !== 'string' || typeof userId !== 'string') {
        throw new Error(
          `Stripe event ${event.id} missing teamId or userId in metadata`
        );
      }
      return next({
        context: {
          stripeEvent: event,
          scopedDb: createScopedDb(teamId, userId),
          teamId,
          userId,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('missing teamId')) {
        throw Response.json({ error: error.message }, { status: 400 });
      }
      throw Response.json({ error: 'Invalid signature' }, { status: 400 });
    }
  }
);

/**
 * Basic auth middleware - requires authenticated user
 * Adds user and session to context
 */
export const authMiddleware = createMiddleware({ type: 'function' })
  .middleware([loggerMiddleware])
  .server(async ({ next }) => {
    const request = getRequest();
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session?.user) {
      throw new Error('Authentication required');
    }

    return next({
      context: {
        user: session.user,
        session,
      },
    });
  });

/**
 * Auth with default team context
 * Automatically resolves user's default team
 */
export const authWithTeamMiddleware = createMiddleware({ type: 'function' })
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    const team = await resolveUserTeam(context.user.id);

    if (!team) {
      throw new Error('No team found for user');
    }

    return next({
      context: {
        teamId: team.teamId,
        scopedDb: createScopedDb(team.teamId, context.user.id),
      },
    });
  });

// ============================================================================
// System Admin Middleware
// ============================================================================

/**
 * System admin middleware - requires ADMIN_EMAILS env var match
 * Extends authWithTeamMiddleware so context includes teamId
 */
export const systemAdminMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .server(async ({ next, context }) => {
    requireSystemAdmin(context.user.email);
    return next({
      context: {
        adminScopedDb: createSystemAdminScopedDb(),
      },
    });
  });

// ============================================================================
// Resource Access Middleware
// ============================================================================

/**
 * Sequence access middleware
 * Loads sequence and verifies team access
 * Requires sequenceId in input data
 */
export const sequenceAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(z.looseObject({ sequenceId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    let sequence = await context.scopedDb.sequences.getById(data.sequenceId);
    let { teamId, scopedDb } = context;

    if (!sequence && isSystemAdmin(context.user.email)) {
      sequence = await getSequenceByIdUnscoped(data.sequenceId);
      if (sequence) {
        teamId = sequence.teamId;
        scopedDb = createScopedDb(sequence.teamId, context.user.id);
      }
    }

    if (!sequence) {
      throw new NotFoundError('Sequence not found');
    }

    return next({
      context: {
        sequence,
        teamId,
        scopedDb,
      },
    });
  });

/**
 * Frame access middleware
 * Loads frame with its sequence and verifies team access
 * Requires sequenceId and frameId in input data
 */
export const frameAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(z.looseObject({ sequenceId: ulidSchema, frameId: ulidSchema }))
  )
  .server(async ({ next, context, data }) => {
    const frameData = await context.scopedDb.frames.getWithSequence(
      data.frameId
    );

    if (!frameData || frameData.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Frame not found in this sequence');
    }

    let { teamId, scopedDb } = context;

    if (frameData.sequence.teamId !== context.teamId) {
      if (!isSystemAdmin(context.user.email)) {
        throw new NotFoundError('Frame not found in this sequence');
      }
      teamId = frameData.sequence.teamId;
      scopedDb = createScopedDb(frameData.sequence.teamId, context.user.id);
    }

    // Extract sequence from frame data (using the partial sequence from the query)
    const { sequence: rawSequence, ...frame } = frameData;

    // Type assertion needed because Drizzle's nested relation inference loses the $type<AspectRatio>() annotation
    const sequence: PartialSequence = {
      ...rawSequence,
      aspectRatio: rawSequence.aspectRatio satisfies AspectRatio,
    };

    return next({
      context: {
        frame,
        sequence,
        teamId,
        scopedDb,
      },
    });
  });

/**
 * Team member access middleware
 * Verifies user has access to the specified team
 * Requires teamId in input data
 */
export const teamMemberAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(z.looseObject({ teamId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    if (data.teamId !== context.teamId) {
      await requireTeamMemberAccess(context.user.id, data.teamId);
    }

    return next({
      context: {
        teamId: data.teamId,
        scopedDb:
          data.teamId === context.teamId
            ? context.scopedDb
            : createScopedDb(data.teamId, context.user.id),
      },
    });
  });

/**
 * Team admin access middleware
 * Verifies user has admin access to the specified team
 * Requires teamId in input data
 */
export const teamAdminAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(z.looseObject({ teamId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    await requireTeamAdminAccess(context.user.id, data.teamId);

    return next({
      context: {
        teamId: data.teamId,
        scopedDb:
          data.teamId === context.teamId
            ? context.scopedDb
            : createScopedDb(data.teamId, context.user.id),
      },
    });
  });

/**
 * Team owner access middleware
 * Verifies user has owner access to the specified team
 * Requires teamId in input data
 */
export const teamOwnerAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(z.looseObject({ teamId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    await requireTeamOwnerAccess(context.user.id, data.teamId);

    return next({
      context: {
        teamId: data.teamId,
        scopedDb:
          data.teamId === context.teamId
            ? context.scopedDb
            : createScopedDb(data.teamId, context.user.id),
      },
    });
  });
