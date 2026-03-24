import { Upload } from 'lucide-react';
import { useRef } from 'react';

interface FileSelectorProps {
  callback: (_files: File[]) => void;
  id: string;
  disabled?: boolean;
  accept?: string;
}

export default function FileSelector({
  callback,
  id,
  disabled,
  accept = 'image/*',
}: FileSelectorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div
        onClick={() => {
          fileInputRef.current?.click();
        }}
        className="bg-foreground/3 flex h-20 w-20 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-lg duration-300 active:scale-95"
      >
        <Upload className="size-6" />
      </div>
      <input
        ref={fileInputRef}
        className="hidden"
        type="file"
        id={`file-${id}`}
        multiple
        accept={accept}
        disabled={disabled}
        onInput={(e) => {
          if (fileInputRef.current?.files) {
            const files = Array.from(fileInputRef.current.files);
            callback(files);
          }
          e.currentTarget.value = '';
        }}
        title="Attachments Uploader"
      />
    </div>
  );
}
