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
  /** Style-recommended model key — renders a "Recommended" badge on the match. */
  recommendedVideoModel?: string | null;
  /** Style name, used in the recommendation tooltip. */
  styleName?: string;
};

export const MotionModelSelector: React.FC<MotionModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled = false,
  aspectRatio,
  styleCategory,
  recommendedVideoModel,
  styleName,
}) => {
  // When the recommendation exists in the model catalog but is filtered out by
  // aspect-ratio compatibility, surface that as a distinct "incompatible with
  // current ratio" badge rather than hiding the recommendation entirely.
  const recommendationStatus = useMemo<
    'matched' | 'incompatible-ratio' | 'unknown' | 'none'
  >(() => {
    if (!recommendedVideoModel) return 'none';
    if (!isValidImageToVideoModel(recommendedVideoModel)) return 'unknown';
    if (
      aspectRatio &&
      !isModelCompatibleWithAspectRatio(recommendedVideoModel, aspectRatio)
    ) {
      return 'incompatible-ratio';
    }
    return 'matched';
  }, [recommendedVideoModel, aspectRatio]);

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
        .map(([key, m]) => {
          const isRecommended = key === recommendedVideoModel;
          const recommendedFor = isRecommended
            ? styleName
              ? `Recommended for ${styleName}`
              : 'Recommended for this style'
            : undefined;
          return {
            id: key,
            name: m.name,
            group: 'all',
            badge: m.license,
            recommendedFor,
          };
        }),
    [aspectRatio, styleCategory, recommendedVideoModel, styleName]
  );

  const recommendedModelName =
    recommendedVideoModel && isValidImageToVideoModel(recommendedVideoModel)
      ? IMAGE_TO_VIDEO_MODELS[recommendedVideoModel].name
      : undefined;

  return (
    <div className="flex flex-col gap-1">
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
      {recommendationStatus === 'incompatible-ratio' &&
        recommendedModelName && (
          <p className="text-[10px] text-muted-foreground">
            {styleName ? `${styleName} recommends` : 'Recommended'}{' '}
            <span className="font-medium">{recommendedModelName}</span>, but
            it's not compatible with the current aspect ratio.
          </p>
        )}
      {recommendationStatus === 'unknown' && (
        <p className="text-[10px] text-muted-foreground">
          {styleName ? `${styleName} recommends` : 'Recommended'} a model that's
          no longer available.
        </p>
      )}
    </div>
  );
};
