import { BaseModelSelector } from './base-model-selector';
import {
  IMAGE_MODELS,
  isValidTextToImageModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { useMemo } from 'react';

const GROUP_ORDER = ['all'] as const;

function useImageModels() {
  return useMemo(
    () =>
      Object.entries(IMAGE_MODELS)
        .filter(([, m]) => !('hidden' in m))
        .sort(([, a], [, b]) => a.qualityRank - b.qualityRank)
        .map(([key, m]) => ({
          id: key,
          name: m.name,
          group: 'all',
          badge: m.license,
        })),
    []
  );
}

type ImageModelSelectorProps = {
  selectedModel: TextToImageModel;
  onModelChange: (model: TextToImageModel) => void;
  disabled?: boolean;
  /** When set, only show these models instead of all available models */
  filterModels?: TextToImageModel[];
};

export const ImageModelSelector: React.FC<ImageModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  disabled = false,
  filterModels,
}) => {
  const allModels = useImageModels();
  const models = filterModels
    ? allModels.filter(
        (m) => isValidTextToImageModel(m.id) && filterModels.includes(m.id)
      )
    : allModels;

  return (
    <BaseModelSelector
      label="Image Model"
      models={models}
      groupOrder={GROUP_ORDER}
      selectedIds={[selectedModel]}
      onSelectionChange={(ids) => {
        const firstId = ids[0];
        if (firstId && isValidTextToImageModel(firstId)) {
          onModelChange(firstId);
        }
      }}
      disabled={disabled}
      multiSelect={false}
    />
  );
};

type ImageModelMultiSelectorProps = {
  selectedModels: TextToImageModel[];
  onModelsChange: (models: TextToImageModel[]) => void;
  disabled?: boolean;
};

export const ImageModelMultiSelector: React.FC<
  ImageModelMultiSelectorProps
> = ({ selectedModels, onModelsChange, disabled = false }) => {
  const models = useImageModels();

  return (
    <BaseModelSelector
      label="Image Models"
      models={models}
      groupOrder={GROUP_ORDER}
      selectedIds={selectedModels}
      onSelectionChange={(ids) => {
        const validIds = ids.filter(isValidTextToImageModel);
        if (validIds.length > 0) {
          onModelsChange(validIds);
        }
      }}
      disabled={disabled}
      multiSelect={true}
    />
  );
};
