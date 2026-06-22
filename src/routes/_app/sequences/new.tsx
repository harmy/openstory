import { BillingGateDialog } from '@/components/billing/billing-gate-dialog';
import { OpenStoryLogo } from '@/components/icons/openstory-logo';
import { PageContainer } from '@/components/layout/page-container';
import { ScriptView } from '@/components/script/script-view';
import { SampleVideoShowcase } from '@/components/style/sample-video-showcase';
import { useBillingGate } from '@/hooks/use-billing-gate';
import { useStyles } from '@/hooks/use-styles';
import { useUser } from '@/hooks/use-user';
import { briefForStyle } from '@/lib/style/brief-for-style';
import { styleSlug } from '@/lib/style/style-slug';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { Route as ScenesRoute } from '@/routes/_app/sequences/$id/scenes';

const BILLING_PROMPT_KEY = 'openstory:billing-prompt-dismissed';
const BILLING_PROMPT_EXPIRY_DAYS = 1;

function wasBillingPromptDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = localStorage.getItem(BILLING_PROMPT_KEY);
  if (!raw) return false;
  const expiry = Number(raw);
  if (Date.now() > expiry) {
    localStorage.removeItem(BILLING_PROMPT_KEY);
    return false;
  }
  return true;
}

function dismissBillingPrompt() {
  const expiry = Date.now() + BILLING_PROMPT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  localStorage.setItem(BILLING_PROMPT_KEY, String(expiry));
}

// `style` carries a sample style's slug from the showcase/gallery "Try this
// style" links (#956); the composer seeds its brief + selects the style.
// `prefill=style` narrows that to style-only — select the style but leave the
// prompt blank (the styles page "Use this style" CTA). Optional, no default —
// a bare /sequences/new must stay a bare URL (no 307 rewrite).
const searchSchema = z.object({
  style: z.string().optional(),
  prefill: z.enum(['style']).optional(),
});

export const Route = createFileRoute('/_app/sequences/new')({
  validateSearch: searchSchema,
  component: NewSequencePage,
  staticData: {
    breadcrumb: [
      { label: 'Sequences', to: '/sequences' },
      { label: 'New sequence' },
    ],
  },
});

function NewSequencePage() {
  const navigate = useNavigate();
  const { style: styleParam, prefill } = Route.useSearch();
  // Session is prefetched in _app/route.tsx beforeLoad, so this is settled on
  // first render — no flash for signed-in users.
  const { data: user } = useUser();

  // Sample-style prefill (#956): the showcase/gallery "Try this style" links
  // carry `?style=<slug>` (the slug the style's assets live under) + `#compose`
  // (so the router scrolls to the composer). Derive the seed straight from the
  // param during render — no effect, no state to keep in sync. The brief is
  // resolved from the style here so the URL only needs the slug; settings
  // (models, aspect ratio) follow once the style is selected. Remounting the
  // composer (`key`) on a new seed lets the `initialScript`/`initialStyleId`
  // props re-seed it — and take precedence over a stale draft (see ScriptView).
  const { data: styles } = useStyles();
  const seedStyle = styleParam
    ? styles?.find((s) => styleSlug(s.name) === styleParam)
    : undefined;
  // `prefill=style` ("Use this style") seeds ONLY the style; the default
  // ("Try" / gallery) also seeds the style's sample brief as the prompt.
  const styleOnly = prefill === 'style';
  let seedScript: string | undefined;
  if (seedStyle && !styleOnly) {
    try {
      seedScript = briefForStyle({
        name: seedStyle.name,
        category: seedStyle.category,
      });
    } catch {
      // Unmapped style — leave the composer blank rather than seed nothing.
      seedScript = undefined;
    }
  }
  // Distinguish the two seed modes in the key so switching between "Try" and
  // "Use this style" for the same style still remounts + re-seeds the composer.
  const composerKey = seedStyle
    ? `seed:${seedStyle.id}:${styleOnly ? 'style' : 'full'}`
    : 'blank';

  const { needsBillingSetup, hasFalKey, hasOpenRouterKey, stripeEnabled } =
    useBillingGate();
  const [billingOpen, setBillingOpen] = useState(false);

  // Clear billing return flag when user is back on this page
  useEffect(() => {
    localStorage.removeItem('openstory:billing-return');
  }, []);

  useEffect(() => {
    if (needsBillingSetup && !wasBillingPromptDismissed()) {
      setBillingOpen(true);
    }
  }, [needsBillingSetup]);

  const handleSuccess = useCallback(
    (sequenceIds: string[]) => {
      const [firstId] = sequenceIds;
      if (firstId) {
        // Navigate to storyboard page after successful generation
        void navigate({
          to: ScenesRoute.to,
          params: { id: firstId },
        });
      }
    },
    [navigate]
  );

  const billingGate = (
    <BillingGateDialog
      open={billingOpen}
      onOpenChange={(open) => {
        setBillingOpen(open);
        if (!open) dismissBillingPrompt();
      }}
      hasFalKey={hasFalKey}
      hasOpenRouterKey={hasOpenRouterKey}
      stripeEnabled={stripeEnabled}
      context="onboarding"
    />
  );

  // Signed-in: the script box fills the screen. Logged-out: lead with the logo
  // and tagline, then show a scrollable showcase of canonical style samples
  // below the script box (#956).
  if (user) {
    return (
      <div className="h-full">
        {billingGate}
        <PageContainer maxWidth="narrow" fullHeight>
          <ScriptView
            key={composerKey}
            loading={false}
            onSuccess={handleSuccess}
            initialScript={seedScript}
            initialStyleId={seedStyle?.id}
          />
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {billingGate}
      <PageContainer maxWidth="narrow" padding="spacious">
        <div className="flex flex-col items-center gap-4">
          <OpenStoryLogo size="xl" />
          <h1 className="text-center text-2xl font-semibold tracking-tight">
            Tell your whole story
          </h1>
        </div>
        {/* `#compose` target: the "Try" links navigate here so the router
            scrolls the composer into view (scrollRestoration handles it). */}
        <div id="compose" className="scroll-mt-4">
          <ScriptView
            key={composerKey}
            loading={false}
            onSuccess={handleSuccess}
            initialScript={seedScript}
            initialStyleId={seedStyle?.id}
          />
        </div>
        <SampleVideoShowcase />
      </PageContainer>
    </div>
  );
}
