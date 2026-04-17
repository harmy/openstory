import { BaseModelSelector } from './base-model-selector';
import {
  IMAGE_TO_VIDEO_MODELS,
  isModelCompatibleWithAspectRatio,
  isValidImageToVideoModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { useMemo } from 'react';

const GROUP_ORDER = ['all'] as const;

type MotionModelSelectorProps = {
  selectedModel: ImageToVideoModel;
  onModelChange: (model: ImageToVideoModel) => void;
  disabled?: boolean;
  aspectRatio?: AspectRatio;
  /** When set, models with a matching `requiredStyleCategory` are included */
  styleCategory?: string;
};

export const MotionModelSelector: React.FC<MotionModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled = false,
  aspectRatio,
  styleCategory,
}) => {
  const models = useMemo(
    () =>
      Object.entries(IMAGE_TO_VIDEO_MODELS)
        .filter(([key, m]) => {
          if (!isValidImageToVideoModel(key)) return false;
          if ('hidden' in m) return false;
          if (
            'requiredStyleCategory' in m &&
            m.requiredStyleCategory !== styleCategory
          )
            return false;
          return aspectRatio
            ? isModelCompatibleWithAspectRatio(key, aspectRatio)
            : true;
        })
        .sort(([, a], [, b]) => a.qualityRank - b.qualityRank)
        .map(([key, m]) => ({
          id: key,
          name: m.name,
          group: 'all',
          badge: m.license,
        })),
    [aspectRatio, styleCategory]
  );

  return (
    <BaseModelSelector
      label="Motion Model"
      models={models}
      groupOrder={GROUP_ORDER}
      selectedIds={[selectedModel]}
      onSelectionChange={(ids) => {
        const firstId = ids[0];
        if (firstId && isValidImageToVideoModel(firstId)) {
          onModelChange(firstId);
        }
      }}
      disabled={disabled}
      multiSelect={false}
    />
  );
};
