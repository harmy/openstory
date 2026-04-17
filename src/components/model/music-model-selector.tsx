import { BaseModelSelector } from './base-model-selector';
import {
  AUDIO_MODELS,
  isValidAudioModel,
  type AudioModel,
} from '@/lib/ai/models';
import { useMemo } from 'react';

const GROUP_ORDER = ['all'] as const;

type MusicModelSelectorProps = {
  selectedModel: AudioModel;
  onModelChange: (model: AudioModel) => void;
  disabled?: boolean;
};

export const MusicModelSelector: React.FC<MusicModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled = false,
}) => {
  const models = useMemo(
    () =>
      Object.entries(AUDIO_MODELS)
        .filter(([key, m]) => {
          if (!isValidAudioModel(key)) return false;
          // Only show music models, not SFX
          return m.type === 'music';
        })
        .sort(([, a], [, b]) => a.qualityRank - b.qualityRank)
        .map(([key, m]) => ({
          id: key,
          name: m.name,
          group: 'all',
          badge: m.license,
        })),
    []
  );

  return (
    <BaseModelSelector
      label="Music Model"
      models={models}
      groupOrder={GROUP_ORDER}
      selectedIds={[selectedModel]}
      onSelectionChange={(ids) => {
        const firstId = ids[0];
        if (firstId && isValidAudioModel(firstId)) {
          onModelChange(firstId);
        }
      }}
      disabled={disabled}
      multiSelect={false}
    />
  );
};
