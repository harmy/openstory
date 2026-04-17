import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Frame } from '@/types/database';
import { Clapperboard, FileTextIcon, ImageIcon, TextIcon } from 'lucide-react';
import { Image } from '@unpic/react';
import type React from 'react';
import { useEffect } from 'react';
import {
  getMotionPrompt,
  getSceneScript,
  getVisualPrompt,
} from './eval-scene-cell';
import type { ViewMode } from './eval-view';

type EvalCellDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  frame: Frame;
  sceneNumber: number;
  sequenceTitle: string;
  initialViewMode: ViewMode;
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
  initialViewMode,
  onNavigateLeft,
  onNavigateRight,
  onNavigateUp,
  onNavigateDown,
}) => {
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
          defaultValue={initialViewMode}
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
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No video available
              </div>
            ) : (
              <div className="flex justify-center items-center h-full">
                <video
                  src={frame.videoUrl}
                  controls
                  loop
                  muted
                  playsInline
                  className="max-w-full max-h-full rounded-lg"
                />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
