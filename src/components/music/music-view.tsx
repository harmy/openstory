import { MusicModelSelector } from '@/components/model/music-model-selector';
import { PromptHistorySheet } from '@/components/prompts/prompt-history-sheet';
import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  DEFAULT_MUSIC_MODEL,
  getAudioModelDurationLimits,
  safeAudioModel,
  type AudioModel,
} from '@/lib/ai/models';
import type { Sequence } from '@/types/database';
import {
  AlertCircle,
  AlertTriangle,
  Film,
  History,
  Loader2,
  Music,
  Volume2,
} from 'lucide-react';
import { useRef, useState } from 'react';

type GenerateMusicArgs = {
  prompt?: string;
  tags?: string;
  model?: string;
  duration?: number;
};

type MergeVideoAndMusicArgs = {
  /** When `false`, restitch frame videos but skip the music mux. */
  includeMusic: boolean;
};

type MusicViewProps = {
  sequence: Sequence;
  videoDuration?: number;
  onGenerateMusic: (args?: GenerateMusicArgs) => void;
  isGeneratingMusic: boolean;
  onMergeVideoAndMusic: (args: MergeVideoAndMusicArgs) => void;
  isMergingVideoAndMusic: boolean;
  /** Banner rendered above the audio player while `musicStatus === 'completed'`. */
  divergentBanner?: React.ReactNode;
  isMusicPromptStale?: boolean;
  onRegenerateMusicPrompt?: () => void;
  isRegeneratingMusicPrompt?: boolean;
};

type LoadingButtonProps = React.ComponentProps<typeof Button> & {
  isLoading: boolean;
  loadingText: string;
  children: React.ReactNode;
};

const LoadingButton: React.FC<LoadingButtonProps> = ({
  isLoading,
  loadingText,
  children,
  ...props
}) => (
  <Button disabled={isLoading || props.disabled} {...props}>
    {isLoading ? (
      <>
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {loadingText}
      </>
    ) : (
      children
    )}
  </Button>
);

type StatusPanelProps = {
  icon: React.ReactNode;
  message?: string;
  children?: React.ReactNode;
  contentWidth?: 'sm' | 'lg';
};

const StatusPanel: React.FC<StatusPanelProps> = ({
  icon,
  message,
  children,
  contentWidth = 'lg',
}) => {
  const maxWidth = contentWidth === 'sm' ? 'max-w-xs' : 'max-w-lg';
  return (
    <div className="flex flex-col items-center gap-6 py-12">
      {icon}
      {message && <p className="text-muted-foreground">{message}</p>}
      {children && (
        <div className={`w-full ${maxWidth} flex flex-col gap-4`}>
          {children}
        </div>
      )}
    </div>
  );
};

type FormFieldProps = {
  label: string;
  htmlFor?: string;
  muted?: boolean;
  children: React.ReactNode;
};

const FormField: React.FC<FormFieldProps> = ({
  label,
  htmlFor,
  muted,
  children,
}) => (
  <div className="flex flex-col gap-2">
    <Label
      htmlFor={htmlFor}
      className={muted ? 'text-xs text-muted-foreground' : undefined}
    >
      {label}
    </Label>
    {children}
  </div>
);

const ReadOnlyField: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <FormField label={label} muted>
    <p className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3">
      {value}
    </p>
  </FormField>
);

export const MusicView: React.FC<MusicViewProps> = ({
  sequence,
  videoDuration,
  onGenerateMusic,
  isGeneratingMusic,
  onMergeVideoAndMusic,
  isMergingVideoAndMusic,
  divergentBanner,
  isMusicPromptStale,
  onRegenerateMusicPrompt,
  isRegeneratingMusicPrompt,
}) => {
  const {
    musicStatus,
    musicUrl,
    musicError,
    musicModel,
    musicPrompt,
    musicTags,
  } = sequence;

  const [editPrompt, setEditPrompt] = useState(musicPrompt ?? '');
  const [editModel, setEditModel] = useState<AudioModel>(() =>
    safeAudioModel(musicModel, DEFAULT_MUSIC_MODEL)
  );
  const [editDuration, setEditDuration] = useState<number | undefined>(
    () => videoDuration
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [includeMusicInMerge, setIncludeMusicInMerge] = useState(true);

  // Resync the textarea when the source-of-truth musicPrompt changes from
  // outside (regenerate, restore, realtime update). Without this, a successful
  // regenerate updates `sequence.musicPrompt` but the textarea keeps showing
  // the user's stale value.
  const prevMusicPromptRef = useRef(musicPrompt);
  if (musicPrompt !== prevMusicPromptRef.current) {
    prevMusicPromptRef.current = musicPrompt;
    setEditPrompt(musicPrompt ?? '');
  }

  const stalenessBanner =
    isMusicPromptStale && onRegenerateMusicPrompt ? (
      <StalenessIndicator
        artifact="music-prompt"
        entityType="sequence"
        density="inline"
        onRegenerate={onRegenerateMusicPrompt}
        isRegenerating={isRegeneratingMusicPrompt}
      />
    ) : null;

  const historyButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setHistoryOpen(true)}
      aria-label="Show music prompt history"
    >
      <History className="mr-2 h-4 w-4" />
      History
    </Button>
  );

  const historySheet = (
    <PromptHistorySheet
      open={historyOpen}
      onOpenChange={setHistoryOpen}
      mode="music"
      sequenceId={sequence.id}
      currentText={musicPrompt ?? ''}
    />
  );

  const prevVideoDurationRef = useRef(videoDuration);
  if (videoDuration !== prevVideoDurationRef.current) {
    prevVideoDurationRef.current = videoDuration;
    setEditDuration(videoDuration);
  }

  const durationLimits = getAudioModelDurationLimits(editModel);
  const effectiveDuration =
    editDuration ?? videoDuration ?? durationLimits.default;
  const durationExceedsMax = effectiveDuration > durationLimits.max;

  function handleGenerate(): void {
    onGenerateMusic({
      prompt: editPrompt || undefined,
      tags: musicTags || undefined,
      model: editModel,
      duration: editDuration,
    });
  }

  if (musicStatus === 'completed' && musicUrl) {
    const isMerging =
      isMergingVideoAndMusic || sequence.mergedVideoStatus === 'merging';

    return (
      <StatusPanel
        icon={<Volume2 className="h-10 w-10 text-muted-foreground" />}
      >
        {divergentBanner}
        {stalenessBanner}
        <audio
          controls
          src={musicUrl}
          crossOrigin="anonymous"
          className="h-10 w-full"
          preload="metadata"
        >
          <track kind="captions" />
        </audio>

        <FormField label="Model" muted>
          <MusicModelSelector
            selectedModel={editModel}
            onModelChange={setEditModel}
          />
        </FormField>

        <ReadOnlyField label="Prompt" value={musicPrompt ?? 'Missing prompt'} />
        <ReadOnlyField label="Tags" value={musicTags ?? 'Missing tags'} />

        <label
          htmlFor="merge-include-music"
          className="flex items-center gap-2 self-center text-sm text-muted-foreground"
        >
          <Checkbox
            id="merge-include-music"
            checked={includeMusicInMerge}
            onCheckedChange={(checked) =>
              setIncludeMusicInMerge(checked === true)
            }
            disabled={isMerging}
          />
          <span>Include music in merged video</span>
        </label>

        <div className="flex justify-center gap-3">
          {historyButton}
          <LoadingButton
            variant="outline"
            onClick={handleGenerate}
            isLoading={isGeneratingMusic}
            loadingText="Regenerating…"
          >
            Regenerate Music
          </LoadingButton>
          <LoadingButton
            onClick={() =>
              onMergeVideoAndMusic({ includeMusic: includeMusicInMerge })
            }
            isLoading={isMerging}
            loadingText="Merging…"
          >
            <Film className="mr-2 h-4 w-4" />
            Merge with Video
          </LoadingButton>
        </div>
        {historySheet}
      </StatusPanel>
    );
  }

  if (musicStatus === 'generating') {
    return (
      <StatusPanel
        icon={
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        }
        message="Generating music…"
      />
    );
  }

  if (musicStatus === 'failed') {
    return (
      <StatusPanel
        icon={<AlertCircle className="h-8 w-8 text-destructive" />}
        contentWidth="sm"
      >
        <p className="text-destructive text-center">Music generation failed</p>
        {musicError && (
          <p className="text-sm text-muted-foreground text-center">
            {musicError}
          </p>
        )}

        <FormField label="Model" muted>
          <MusicModelSelector
            selectedModel={editModel}
            onModelChange={setEditModel}
          />
        </FormField>

        <LoadingButton
          className="self-center"
          onClick={handleGenerate}
          isLoading={isGeneratingMusic}
          loadingText="Retrying…"
        >
          Retry
        </LoadingButton>
      </StatusPanel>
    );
  }

  const promptPending = !musicPrompt;

  return (
    <StatusPanel
      icon={<Music className="h-8 w-8 text-muted-foreground" />}
      message={promptPending ? 'Preparing music…' : 'Music prompt ready'}
    >
      {stalenessBanner}
      <FormField label="Prompt" htmlFor="music-prompt">
        <Textarea
          id="music-prompt"
          value={editPrompt}
          onChange={(e) => setEditPrompt(e.target.value)}
          rows={4}
          disabled={promptPending}
          placeholder={
            promptPending
              ? 'Generating music prompt…'
              : 'Descriptive music prompt…'
          }
        />
      </FormField>

      <FormField label="Tags" muted>
        {musicTags ? (
          <p className="text-sm text-muted-foreground">{musicTags}</p>
        ) : (
          <p className="text-sm text-muted-foreground/60">Generating…</p>
        )}
      </FormField>

      <FormField label="Model">
        <MusicModelSelector
          selectedModel={editModel}
          onModelChange={setEditModel}
        />
      </FormField>

      <FormField label="Duration (seconds)" htmlFor="music-duration">
        <Input
          id="music-duration"
          type="number"
          min={1}
          max={durationLimits.max}
          value={effectiveDuration}
          onChange={(e) => setEditDuration(Number(e.target.value))}
        />
        {durationExceedsMax && (
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            Video is {Math.round(effectiveDuration)}s but {editModel} max is{' '}
            {durationLimits.max}s — music will be clamped.
          </p>
        )}
      </FormField>

      <div className="flex justify-center gap-3">
        {historyButton}
        <LoadingButton
          onClick={handleGenerate}
          disabled={!editPrompt}
          isLoading={isGeneratingMusic}
          loadingText="Generating…"
        >
          Generate Music
        </LoadingButton>
      </div>
      {historySheet}
    </StatusPanel>
  );
};

export const MusicViewSkeleton: React.FC = () => (
  <StatusPanel icon={<Skeleton className="h-10 w-10 rounded-full" />}>
    <Skeleton className="h-10 w-full" />
  </StatusPanel>
);
