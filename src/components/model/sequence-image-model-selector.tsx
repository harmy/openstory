import { AddModelMenuSection } from '@/components/model/add-model-menu';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ModelCoverageMarker } from '@/components/model/model-coverage-marker';
import { SetModelButton } from '@/components/model/set-model-button';
import { useActiveImageModel } from '@/hooks/use-active-image-model';
import {
  useSequenceImageModels,
  useSequenceImageVariants,
  useShotsBySequence,
} from '@/hooks/use-shots';
import { IMAGE_MODELS, isValidTextToImageModel } from '@/lib/ai/models';
import { computeSequenceModelCoverage } from '@/lib/model/sequence-model-coverage';
import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';

function imageModelName(model: string): string {
  return isValidTextToImageModel(model) ? IMAGE_MODELS[model].name : model;
}

/**
 * Top-level image-model switcher for the sequence header. Lists the distinct
 * image models that have generated for this sequence (shot_variants) and lets
 * the viewer pick which model's image the scenes view shows; also hosts the
 * "Add a model" picker (#547). "Mixed" when more than one model has output and
 * none is pinned. Replaces the read-only ImageModelBadge.
 */
export const SequenceImageModelSelector = ({
  sequenceId,
  sequenceImageModel,
}: {
  sequenceId: string;
  sequenceImageModel?: string | null;
}) => {
  const { data: models } = useSequenceImageModels(sequenceId);
  const { data: variants } = useSequenceImageVariants(sequenceId);
  const { data: shots } = useShotsBySequence(sequenceId);
  const { activeImageModel, selectImageModel } =
    useActiveImageModel(sequenceId);

  // Map shots → their parent scene so coverage counts at scene granularity (#909).
  const shotToScene = useMemo(() => {
    const map = new Map<string, string>();
    for (const shot of shots ?? []) map.set(shot.id, shot.sceneId ?? shot.id);
    return map;
  }, [shots]);

  const coverage = useMemo(
    () =>
      computeSequenceModelCoverage({
        variants,
        variantType: 'image',
        primaryModel: sequenceImageModel,
        shotToScene,
      }),
    [variants, sequenceImageModel, shotToScene]
  );

  if (!models || models.length === 0) {
    if (!sequenceImageModel) return null;
    return (
      <Badge variant="secondary" className="text-xs">
        {imageModelName(sequenceImageModel)}
      </Badge>
    );
  }

  const firstModel = models[0];
  const label = activeImageModel
    ? imageModelName(activeImageModel)
    : models.length === 1 && firstModel
      ? imageModelName(firstModel)
      : 'Mixed';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Select image model">
          <Badge variant="secondary" className="text-xs cursor-pointer gap-1">
            {label}
            <ChevronDown className="size-3" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        <DropdownMenuLabel className="text-xs">
          Image model
          <span className="block font-normal text-muted-foreground">
            View a model across the sequence; Set applies it to every scene.
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.length > 1 && (
          <DropdownMenuCheckboxItem
            checked={activeImageModel === null}
            onCheckedChange={() => selectImageModel(null)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            Mixed (per scene)
          </DropdownMenuCheckboxItem>
        )}
        {models.filter(isValidTextToImageModel).map((model) => (
          <DropdownMenuCheckboxItem
            key={model}
            checked={activeImageModel === model}
            onCheckedChange={() => selectImageModel(model)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="truncate">{imageModelName(model)}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <ModelCoverageMarker coverage={coverage.get(model)} />
                <SetModelButton
                  sequenceId={sequenceId}
                  variantType="image"
                  model={model}
                  modelName={imageModelName(model)}
                  coverage={coverage.get(model)}
                />
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <AddModelMenuSection
          sequenceId={sequenceId}
          variantType="image"
          usedModels={models}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
