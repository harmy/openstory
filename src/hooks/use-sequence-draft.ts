import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

const STORAGE_KEY = 'openstory:sequence-draft:v1';
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const draftElementSchema = z.object({
  tempPath: z.string(),
  tempPublicUrl: z.string(),
  filename: z.string(),
  token: z.string(),
  description: z.string().nullable().default(null),
  consistencyTag: z.string().nullable().default(null),
});

const sequenceDraftSchema = z.object({
  script: z.string().default(''),
  styleId: z.string().nullable().default(null),
  selectedTalentIds: z.array(z.string()).default([]),
  selectedLocationIds: z.array(z.string()).default([]),
  elementUploads: z.array(draftElementSchema).default([]),
  savedAt: z.number().default(0),
});

export type DraftElement = z.infer<typeof draftElementSchema>;
type SequenceDraft = z.infer<typeof sequenceDraftSchema>;

const EMPTY_DRAFT: SequenceDraft = {
  script: '',
  styleId: null,
  selectedTalentIds: [],
  selectedLocationIds: [],
  elementUploads: [],
  savedAt: 0,
};

function loadDraft(): SequenceDraft | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;

    const result = sequenceDraftSchema.safeParse(JSON.parse(stored));
    if (!result.success) return null;
    const draft = result.data;

    // Check expiry
    if (Date.now() - draft.savedAt > EXPIRY_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return draft;
  } catch {
    return null;
  }
}

function persistDraft(draft: Omit<SequenceDraft, 'savedAt'>): void {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...draft, savedAt: Date.now() })
    );
  } catch {
    // localStorage full or unavailable
  }
}

export function useSequenceDraft() {
  const [draft, setDraft] = useState<SequenceDraft>(EMPTY_DRAFT);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const loaded = loadDraft();
    if (loaded) {
      setDraft(loaded);
    }
    setIsLoaded(true);
  }, []);

  const saveDraft = useCallback((data: Omit<SequenceDraft, 'savedAt'>) => {
    setDraft({ ...data, savedAt: Date.now() });
    persistDraft(data);
  }, []);

  const clearDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  return { draft, isLoaded, saveDraft, clearDraft };
}
