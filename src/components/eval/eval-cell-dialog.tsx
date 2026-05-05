import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { VideoPlayer } from '@/components/motion/video-player';
import type { Frame } from '@/types/database';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import {
  Clapperboard,
  FileTextIcon,
  ImageIcon,
  Film,
  TextIcon,
} from 'lucide-react';
import { Image } from '@unpic/react';
import type React from 'react';
import { useEffect } from 'react';
import {
  getMotionPrompt,
  getSceneScript,
  getVisualPrompt,
} from './eval-scene-cell';
import type { ViewMode } from './eval-view';

export type DialogTab = ViewMode | 'theatre';

type EvalCellDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  frame: Frame;
  sceneNumber: number;
  sequenceTitle: string;
  aspectRatio: AspectRatio;
  initialTab: DialogTab;
  mergedVideoUrl?: string | null;
  mergedVideoPoster?: string | null;
  onNavigateLeft?: () => void;
  onNavigateRight?: () => void;
  onNavigateUp?: () => void;
  onNavigateDown?: () => void;
};

export const EvalCellDialog: React.FC<EvalCellDialogProps> = ({
  open,
  onOpenChange,
  frame,
  sceneNumber,
  sequenceTitle,
  aspectRatio,
  initialTab,
  mergedVideoUrl,
  mergedVideoPoster,
  onNavigateLeft,
  onNavigateRight,
  onNavigateUp,
  onNavigateDown,
}) => {
  const hasTheatre = Boolean(mergedVideoUrl);
  const prompt = getVisualPrompt(frame);
  const motionPrompt = getMotionPrompt(frame);
  const script = getSceneScript(frame);

  // Handle keyboard navigation
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't navigate if user is typing in an input/textarea
      if (!(e.target instanceof HTMLElement)) return;
      const target = e.target;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          e.stopPropagation();
          onNavigateLeft?.();
          break;
        case 'ArrowRight':
          e.preventDefault();
          e.stopPropagation();
          onNavigateRight?.();
          break;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          onNavigateUp?.();
          break;
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          onNavigateDown?.();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true); // Use capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onNavigateLeft, onNavigateRight, onNavigateUp, onNavigateDown]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[80vw]! max-h-[80vh] w-full h-full flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {sequenceTitle} - Scene {sceneNumber}
          </DialogTitle>
          <DialogDescription>
            View scene details, prompts, and generated images.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue={initialTab}
          className="w-full flex-1 flex flex-col min-h-0"
        >
          <div className="flex justify-center mb-4">
            <TabsList
              onKeyDown={(e) => {
                // Prevent tabs from handling arrow keys - we use them for cell navigation
                if (
                  e.key === 'ArrowLeft' ||
                  e.key === 'ArrowRight' ||
                  e.key === 'ArrowUp' ||
                  e.key === 'ArrowDown'
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
            >
              {hasTheatre && (
                <TabsTrigger value="theatre">
                  <Film className="h-4 w-4 mr-2" />
                  Theatre
                </TabsTrigger>
              )}
              <TabsTrigger value="script">
                <FileTextIcon className="h-4 w-4 mr-2" />
                Script
              </TabsTrigger>
              <TabsTrigger value="prompts">
                <TextIcon className="h-4 w-4 mr-2" />
                Prompts
              </TabsTrigger>
              <TabsTrigger value="images">
                <ImageIcon className="h-4 w-4 mr-2" />
                Image
              </TabsTrigger>
              <TabsTrigger value="motion">
                <Clapperboard className="h-4 w-4 mr-2" />
                Motion
              </TabsTrigger>
            </TabsList>
          </div>

          {hasTheatre && (
            <TabsContent value="theatre" className="flex-1 min-h-0 mt-0">
              <div className="flex justify-center items-center h-full w-full">
                <div className="w-full max-w-5xl">
                  <VideoPlayer
                    src={mergedVideoUrl ?? ''}
                    posterSrc={mergedVideoPoster}
                    aspectRatio={aspectRatio}
                    className="rounded-lg"
                  />
                </div>
              </div>
            </TabsContent>
          )}

          <TabsContent value="script" className="flex-1 min-h-0 mt-0">
            {!script ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No script available
              </div>
            ) : (
              <ScrollArea className="h-full">
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {script}
                </p>
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="prompts" className="flex-1 min-h-0 mt-0">
            {!prompt && !motionPrompt ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No prompts available
              </div>
            ) : (
              <ScrollArea className="h-full">
                {prompt && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      Visual
                    </p>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">
                      {prompt}
                    </p>
                  </div>
                )}
                {prompt && motionPrompt && <hr className="my-3 border-muted" />}
                {motionPrompt && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      Motion
                    </p>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">
                      {motionPrompt}
                    </p>
                  </div>
                )}
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="images" className="flex-1 min-h-0 mt-0">
            {!frame.thumbnailUrl ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No image available
              </div>
            ) : (
              <div className="flex justify-center items-center h-full">
                <Image
                  src={frame.thumbnailUrl}
                  alt={`Scene ${sceneNumber}`}
                  className="max-w-full max-h-full object-contain rounded-lg"
                  width={1000}
                  height={1000}
                />
              </div>
            )}
          </TabsContent>

          <TabsContent value="motion" className="flex-1 min-h-0 mt-0">
            {!frame.videoUrl ? (
              frame.thumbnailUrl ? (
                <div className="flex justify-center items-center h-full w-full">
                  <div className="relative w-full max-w-4xl">
                    <Image
                      src={frame.thumbnailUrl}
                      alt={`Scene ${sceneNumber} preview`}
                      className="w-full h-auto object-contain rounded-lg opacity-60"
                      width={1920}
                      height={1080}
                    />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <span className="text-sm font-medium text-foreground bg-background/85 backdrop-blur-sm px-3 py-1.5 rounded-md border">
                        {frame.videoStatus === 'generating'
                          ? 'Generating video…'
                          : 'No video yet'}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  No video available
                </div>
              )
            ) : (
              <div className="flex justify-center items-center h-full w-full">
                <div className="w-full max-w-4xl">
                  <VideoPlayer
                    src={frame.videoUrl}
                    posterSrc={frame.thumbnailUrl}
                    aspectRatio={aspectRatio}
                    className="rounded-lg"
                  />
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
