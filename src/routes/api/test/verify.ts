import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { createOtpVerification } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const VerifySchema = z.object({
  email: z.string(),
  otp: z.string(),
});

export const Route = createFileRoute('/api/test/verify')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const { email, otp } = VerifySchema.parse(await request.json());

          if (!email || !otp) {
            return Response.json(
              { error: 'email and otp are required' },
              { status: 400 }
            );
          }

          // Better Auth's emailOTP plugin (used by signIn.emailOtp on the client)
          // stores the record under `sign-in-otp-${email}` with a `:0` attempt suffix.
          // The e2e backdoor accepts the raw user email and normalizes it so the
          // magic OTP login flow (`123456`) works on the /verify page.
          const identifier = `sign-in-otp-${email}`;
          const value = `${otp}:0`;

          await createOtpVerification(identifier, value);
          return Response.json({ success: true });
        },
      }),
  },
});
