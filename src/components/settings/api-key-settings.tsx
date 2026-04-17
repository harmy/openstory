/**
 * API Key Settings Component
 * Manages BYOK (Bring Your Own Key) for OpenRouter and Fal.ai
 */

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  checkApiKeyStatusFn,
  deleteApiKeyFn,
  listApiKeysFn,
  saveApiKeyFn,
} from '@/functions/api-keys';
import { initiateOpenRouterOAuthFn } from '@/functions/openrouter-oauth';
import { getCurrentUserProfileFn } from '@/functions/user';
import { BILLING_GATE_KEY } from '@/hooks/use-billing-gate';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, Key, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type ApiKeySettingsProps = {
  success?: string;
  error?: string;
};

export function ApiKeySettings(props: ApiKeySettingsProps) {
  const { data: profile } = useQuery({
    queryKey: ['currentUserProfile'],
    queryFn: () => getCurrentUserProfileFn(),
    staleTime: 5 * 60 * 1000,
  });

  if (!profile?.teamId) {
    return <ApiKeySettingsLoading />;
  }

  return <ApiKeySettingsContent teamId={profile.teamId} {...props} />;
}

function ApiKeySettingsLoading() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-10 w-48" />
      </CardHeader>
      <CardContent className="space-y-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </CardContent>
    </Card>
  );
}

const RETURN_KEY = 'openstory:billing-return';

function ApiKeySettingsContent({
  teamId,
  success,
  error: urlError,
}: ApiKeySettingsProps & { teamId: string }) {
  const queryClient = useQueryClient();
  const posthog = usePostHog();
  const [falKeyInput, setFalKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const hasShownToastRef = useRef(false);

  const { data: apiKeys, isLoading: keysLoading } = useQuery({
    queryKey: ['apiKeys', teamId],
    queryFn: () => listApiKeysFn({ data: { teamId } }),
    staleTime: 5 * 60 * 1000,
  });

  const { data: keyStatus, isLoading: statusLoading } = useQuery({
    queryKey: ['apiKeyStatus', teamId],
    queryFn: () => checkApiKeyStatusFn({ data: { teamId } }),
    staleTime: 5 * 60 * 1000,
  });

  // Show toast when both keys become configured and there's a return path
  useEffect(() => {
    if (hasShownToastRef.current) return;
    if (keyStatus?.fal !== 'team' || keyStatus.openrouter !== 'team') return;
    const returnTo = localStorage.getItem(RETURN_KEY);
    if (!returnTo) return;

    hasShownToastRef.current = true;
    localStorage.removeItem(RETURN_KEY);
    toast.success('API keys configured', {
      description: 'Both fal.ai and OpenRouter are connected.',
      action: {
        label: 'Continue creating',
        onClick: () => void navigate({ to: returnTo }),
      },
      duration: 15_000,
    });
  }, [keyStatus, navigate]);

  const invalidateKeys = () => {
    void queryClient.invalidateQueries({ queryKey: ['apiKeys', teamId] });
    void queryClient.invalidateQueries({ queryKey: ['apiKeyStatus', teamId] });
    void queryClient.invalidateQueries({ queryKey: [...BILLING_GATE_KEY] });
  };

  const saveFalKeyMutation = useMutation({
    mutationFn: (apiKey: string) =>
      saveApiKeyFn({ data: { teamId, provider: 'fal', apiKey } }),
    onSuccess: () => {
      invalidateKeys();
      setFalKeyInput('');
      setError(null);
      posthog.capture('api_key_saved', { provider: 'fal' });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (provider: 'openrouter' | 'fal') =>
      deleteApiKeyFn({ data: { teamId, provider } }),
    onSuccess: (_, provider) => {
      invalidateKeys();
      setError(null);
      posthog.capture('api_key_deleted', { provider });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to delete key');
    },
  });

  const oauthMutation = useMutation({
    mutationFn: () => initiateOpenRouterOAuthFn({ data: { teamId } }),
    onSuccess: (data) => {
      posthog.capture('openrouter_oauth_started');
      window.location.href = data.authUrl;
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to start OAuth');
    },
  });

  const isLoading = keysLoading || statusLoading;

  const openrouterKey = apiKeys?.find((k) => k.provider === 'openrouter');
  const falKey = apiKeys?.find((k) => k.provider === 'fal');

  const handleSaveFalKey = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!falKeyInput.trim()) return;
    saveFalKeyMutation.mutate(falKeyInput.trim());
  };

  const successMessage =
    success === 'openrouter_connected'
      ? 'OpenRouter connected successfully.'
      : null;

  const errorMessage =
    urlError === 'openrouter_oauth_missing_code'
      ? 'OAuth failed: missing authorization code.'
      : urlError === 'openrouter_oauth_no_team'
        ? 'OAuth failed: no team found.'
        : urlError === 'openrouter_oauth_failed'
          ? 'OAuth failed: could not connect to OpenRouter.'
          : null;

  return (
    <div className="space-y-6">
      {successMessage && (
        <Alert>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      {(errorMessage || error) && (
        <Alert variant="destructive">
          <AlertDescription>{error || errorMessage}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <Key className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>API Keys</CardTitle>
              <CardDescription>
                Use your own API keys for AI generation, or fall back to
                platform keys
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* OpenRouter Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">OpenRouter</h3>
                <p className="text-xs text-muted-foreground">
                  AI model routing for image generation
                </p>
              </div>
              {isLoading ? (
                <Skeleton className="h-5 w-20" />
              ) : (
                <StatusBadge source={keyStatus?.openrouter} />
              )}
            </div>

            {isLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : openrouterKey ? (
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">
                      Connected via{' '}
                      {openrouterKey.source === 'oauth'
                        ? 'OAuth'
                        : 'manual entry'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Key ending in {openrouterKey.keyHint}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => deleteMutation.mutate('openrouter')}
                  disabled={deleteMutation.isPending}
                  aria-label="Delete OpenRouter key"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ) : (
              <Button
                onClick={() => oauthMutation.mutate()}
                disabled={oauthMutation.isPending}
                className="w-full"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                {oauthMutation.isPending
                  ? 'Connecting…'
                  : 'Connect with OpenRouter'}
              </Button>
            )}
          </div>

          <div className="border-t" />

          {/* Fal.ai Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">Fal.ai</h3>
                <p className="text-xs text-muted-foreground">
                  Image and video generation
                </p>
              </div>
              {isLoading ? (
                <Skeleton className="h-5 w-20" />
              ) : (
                <StatusBadge source={keyStatus?.fal} />
              )}
            </div>

            {isLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : falKey ? (
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Manual key</p>
                    <p className="text-xs text-muted-foreground">
                      Key ending in {falKey.keyHint}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => deleteMutation.mutate('fal')}
                  disabled={deleteMutation.isPending}
                  aria-label="Delete Fal.ai key"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSaveFalKey} className="flex gap-2">
                <Input
                  name="falKey"
                  type="password"
                  placeholder="fal_..."
                  value={falKeyInput}
                  onChange={(e) => setFalKeyInput(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <Button
                  type="submit"
                  disabled={saveFalKeyMutation.isPending || !falKeyInput.trim()}
                >
                  {saveFalKeyMutation.isPending ? 'Saving…' : 'Save'}
                </Button>
              </form>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ source }: { source?: 'team' | 'platform' }) {
  if (source === 'team') {
    return (
      <Badge variant="default" className="text-xs">
        Your key
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs">
      Platform key
    </Badge>
  );
}
