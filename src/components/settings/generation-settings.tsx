import {
  ImageModelMultiSelector,
  ImageModelSelector,
} from '@/components/model/image-model-selector';
import { ModelSelector } from '@/components/model/model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { MusicModelSelector } from '@/components/model/music-model-selector';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import type {
  AudioModel,
  ImageToVideoModel,
  TextToImageModel,
} from '@/lib/ai/models';
import type { AnalysisModelId } from '@/lib/ai/models.config';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { useState, type FC } from 'react';
import { AspectRatioPills } from './aspect-ratio-pills';
import { GenerationSettingsTrigger } from './generation-settings-trigger';

type AutoToggleProps = {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

const AutoToggle: FC<AutoToggleProps> = ({
  id,
  label,
  checked,
  onChange,
  disabled,
}) => (
  <div className="flex items-center gap-2">
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="h-4 w-4 rounded border-border text-primary focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
    />
    <Label htmlFor={id} className="text-sm font-normal cursor-pointer">
      {label}
    </Label>
  </div>
);

type GenerationSettingsProps = {
  aspectRatio: AspectRatio;
  analysisModels: AnalysisModelId[];
  imageModels: TextToImageModel[];
  motionModel: ImageToVideoModel;
  autoGenerateMotion?: boolean;
  musicModel?: AudioModel;
  autoGenerateMusic?: boolean;
  onAspectRatioChange: (value: AspectRatio) => void;
  onAnalysisModelsChange: (value: AnalysisModelId[]) => void;
  onImageModelsChange: (value: TextToImageModel[]) => void;
  onMotionModelChange: (value: ImageToVideoModel) => void;
  onAutoGenerateMotionChange?: (value: boolean) => void;
  onMusicModelChange?: (value: AudioModel) => void;
  onAutoGenerateMusicChange?: (value: boolean) => void;
  disabled?: boolean;
  singleSelectAnalysis?: boolean;
  /** Use single-select for image model (e.g. in regeneration context) */
  singleSelectImage?: boolean;
  /** Current style category, used to show/hide style-restricted motion models */
  styleCategory?: string;
};

export const GenerationSettings: FC<GenerationSettingsProps> = ({
  aspectRatio,
  analysisModels,
  imageModels,
  motionModel,
  autoGenerateMotion = false,
  musicModel,
  autoGenerateMusic = false,
  onAspectRatioChange,
  onAnalysisModelsChange,
  onImageModelsChange,
  onMotionModelChange,
  onAutoGenerateMotionChange,
  onMusicModelChange,
  onAutoGenerateMusicChange,
  disabled = false,
  singleSelectAnalysis = false,
  singleSelectImage = false,
  styleCategory,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <GenerationSettingsTrigger
          aspectRatio={aspectRatio}
          autoGenerateMotion={autoGenerateMotion}
          autoGenerateMusic={autoGenerateMusic}
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-4" align="start">
        <div className="flex flex-col gap-4">
          {/* Aspect Ratio Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              Aspect Ratio
            </h3>
            <AspectRatioPills
              value={aspectRatio}
              onChange={onAspectRatioChange}
            />
          </section>

          <Separator />

          {/* Analysis Model Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              Analysis Model
            </h3>
            <ModelSelector
              selectedModels={analysisModels}
              onModelsChange={onAnalysisModelsChange}
              disabled={disabled}
              singleSelect={singleSelectAnalysis}
            />
          </section>

          <Separator />

          {/* Image Model Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              Image Model{!singleSelectImage && 's'}
            </h3>
            {singleSelectImage ? (
              <ImageModelSelector
                selectedModel={imageModels[0]}
                onModelChange={(model) => onImageModelsChange([model])}
                disabled={disabled}
              />
            ) : (
              <ImageModelMultiSelector
                selectedModels={imageModels}
                onModelsChange={onImageModelsChange}
                disabled={disabled}
              />
            )}
          </section>

          <Separator />

          {/* Motion Model Section */}
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">
              Motion Model
            </h3>
            {onAutoGenerateMotionChange && (
              <AutoToggle
                id="auto-generate-motion"
                label="Auto-generate motion"
                checked={autoGenerateMotion}
                onChange={onAutoGenerateMotionChange}
                disabled={disabled}
              />
            )}
            <MotionModelSelector
              selectedModel={motionModel}
              onModelChange={onMotionModelChange}
              disabled={disabled || !autoGenerateMotion}
              aspectRatio={aspectRatio}
              styleCategory={styleCategory}
            />
          </section>

          {onAutoGenerateMusicChange && onMusicModelChange && musicModel && (
            <>
              <Separator />

              {/* Music Model Section */}
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-foreground">Music</h3>
                <AutoToggle
                  id="auto-generate-music"
                  label="Auto-generate music"
                  checked={autoGenerateMusic}
                  onChange={onAutoGenerateMusicChange}
                  disabled={disabled}
                />
                <MusicModelSelector
                  selectedModel={musicModel}
                  onModelChange={onMusicModelChange}
                  disabled={disabled || !autoGenerateMusic}
                />
              </section>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
