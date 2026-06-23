import type { SequenceWithShots } from '@/hooks/use-sequences-with-shots';

export type CreatorIdentity = {
  name: string | null;
  email: string | null;
};

export function getCreatorIdentity(
  sequence: Pick<SequenceWithShots, 'creatorName' | 'creatorEmail'>
): CreatorIdentity {
  return {
    name: sequence.creatorName ?? null,
    email: sequence.creatorEmail ?? null,
  };
}
