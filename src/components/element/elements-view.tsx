import { Button } from '@/components/ui/button';
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemPreview,
  FileUploadItemProgress,
  FileUploadList,
  FileUploadTrigger,
  type FileUploadProps,
} from '@/components/ui/file-upload';
import {
  useFrameCountsForAllElements,
  useSequenceElements,
  useUploadElementToSequence,
} from '@/hooks/use-sequence-elements';
import { getFileKey } from '@/lib/utils/upload';
import { Upload, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ElementCard } from './element-card';

type ElementsViewProps = {
  sequenceId: string;
};

export const ElementsView: React.FC<ElementsViewProps> = ({ sequenceId }) => {
  const { data: elements = [] } = useSequenceElements(sequenceId);
  const { data: frameCounts } = useFrameCountsForAllElements(sequenceId);
  const uploadMutation = useUploadElementToSequence();
  const [files, setFiles] = useState<File[]>([]);

  const onUpload: NonNullable<FileUploadProps['onUpload']> = useCallback(
    async (newFiles, { onProgress, onSuccess, onError }) => {
      for (const file of newFiles) {
        try {
          await uploadMutation.mutateAsync({
            file,
            sequenceId,
            onProgress: (pct) => onProgress(file, pct),
          });
          onProgress(file, 100);
          onSuccess(file);
        } catch (err) {
          onError(
            file,
            err instanceof Error ? err : new Error('Upload failed')
          );
        }
      }
      setFiles([]);
    },
    [sequenceId, uploadMutation]
  );

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto px-6 py-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Elements</h2>
        <p className="text-sm text-muted-foreground">
          Upload reference images (logos, products, screenshots) and reference
          them by the UPPERCASE token in your script. Images are described by a
          vision model and used when generating scene frames.
        </p>
      </div>

      <FileUpload
        accept="image/*"
        multiple
        value={files}
        onValueChange={setFiles}
        onUpload={onUpload}
      >
        <FileUploadDropzone className="min-h-[120px] focus:border-ring/50 focus:bg-accent/30">
          <Upload className="size-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">Drag & drop or paste</p>
          <FileUploadTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              Browse files
            </Button>
          </FileUploadTrigger>
        </FileUploadDropzone>
        <FileUploadList className="grid grid-cols-4 gap-3">
          {files.map((file) => (
            <FileUploadItem
              key={getFileKey(file)}
              value={file}
              className="relative aspect-square p-0 border-0 overflow-hidden rounded-md"
            >
              <FileUploadItemPreview className="size-full rounded-none border-0" />
              <FileUploadItemProgress className="absolute bottom-0 left-0 right-0 h-1" />
              <FileUploadItemDelete asChild>
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute top-1 right-1 size-6"
                >
                  <X className="size-3" />
                </Button>
              </FileUploadItemDelete>
            </FileUploadItem>
          ))}
        </FileUploadList>
      </FileUpload>

      {elements.length === 0 ? (
        <p className="text-sm text-muted-foreground">No elements yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {elements.map((el) => (
            <ElementCard
              key={el.id}
              element={el}
              sequenceId={sequenceId}
              affectedFrameCount={frameCounts?.[el.id]?.frameCount ?? 0}
              affectedVideoCount={frameCounts?.[el.id]?.videoCount ?? 0}
            />
          ))}
        </div>
      )}
    </div>
  );
};
