import { Alert, AlertDescription } from '@/components/ui/alert';
import { useBillingGateQuery } from '@/hooks/use-billing-gate';
import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';

export const InvalidApiKeyBanner: React.FC = () => {
  const { data } = useBillingGateQuery();
  if (!data?.openRouterKeyInvalid) return null;

  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>
          Your OpenRouter API key is invalid. Generations are falling back to
          the platform key until you fix it.
        </span>
        <Link
          to="/settings/api-keys"
          className="shrink-0 font-medium underline"
        >
          Fix in settings →
        </Link>
      </AlertDescription>
    </Alert>
  );
};
