import type { Attachment } from '@/types/main';
import { getAttachmentMediaKind } from '@/utils/directUpload';
import { PhotoProvider, PhotoView } from 'react-photo-view';
import 'react-photo-view/dist/react-photo-view.css';

interface AttachmentsGridProps {
  attachments: Attachment[];
  withTimeStamp?: boolean;
}

/**
 * AttachmentsGrid 组件 - 用于显示附件网格
 * 支持1-9张图片的自适应布局
 */
export default function AttachmentsGrid({ attachments, withTimeStamp }: AttachmentsGridProps) {
  const sortedAttachments = [...attachments].sort((a, b) => (a.sortIndex > b.sortIndex ? 1 : -1));
  const hasVideo = sortedAttachments.some(
    (attachment) => getAttachmentMediaKind(attachment) === 'video'
  );

  return (
    attachments.length > 0 && (
      <div className="my-2 flex w-fit flex-wrap gap-1 overflow-hidden rounded-2xl">
        {hasVideo ? (
          sortedAttachments.map((file, index) => (
            <video
              key={`files_${index}`}
              className="bg-foreground/3 w-full max-w-[500px] rounded-2xl border-[0.5px]"
              src={file.url}
              controls
              playsInline
              preload="metadata"
            />
          ))
        ) : (
          <PhotoProvider>
            {sortedAttachments.map((file, index) => (
              <PhotoView key={`files_${index}`} src={file.url}>
                <img
                  className={`${
                    attachments.length % 3 === 0
                      ? 'aspect-square w-[calc(1/3*100%-4px)]'
                      : attachments.length % 2 === 0
                        ? 'aspect-square w-[calc(1/2*100%-3px)]'
                        : attachments.length === 1
                          ? 'w-full max-w-[500px] rounded-2xl border-[0.5px]'
                          : 'aspect-square w-[calc(1/3*100%-3px)]'
                  } bg-foreground/3 grow object-cover`}
                  src={`${file.compressUrl || file.url}`}
                  crossOrigin={withTimeStamp ? 'anonymous' : undefined}
                  alt=""
                />
              </PhotoView>
            ))}
          </PhotoProvider>
        )}
      </div>
    )
  );
}
