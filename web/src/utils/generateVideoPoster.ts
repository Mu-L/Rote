const DEFAULT_CAPTURE_SECONDS = 0.15;
const DEFAULT_MAX_DIMENSION = 1600;
const DEFAULT_QUALITY = 0.82;

function waitForEvent(
  target: HTMLVideoElement,
  eventName: 'loadeddata' | 'loadedmetadata' | 'seeked'
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, handleSuccess);
      target.removeEventListener('error', handleError);
    };

    const handleSuccess = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error(`Video event failed: ${eventName}`));
    };

    target.addEventListener(eventName, handleSuccess, { once: true });
    target.addEventListener('error', handleError, { once: true });
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

export async function generateVideoPoster(
  file: Blob,
  options?: {
    captureSeconds?: number;
    maxDimension?: number;
    quality?: number;
  }
) {
  if (typeof document === 'undefined') {
    return null;
  }

  const captureSeconds = options?.captureSeconds ?? DEFAULT_CAPTURE_SECONDS;
  const maxDimension = options?.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const quality = options?.quality ?? DEFAULT_QUALITY;
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');

  video.muted = true;
  video.preload = 'metadata';
  video.playsInline = true;
  video.src = objectUrl;

  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForEvent(video, 'loadedmetadata');
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const targetTime = duration > 0 ? Math.min(captureSeconds, Math.max(duration - 0.01, 0)) : 0;

    if (targetTime > 0) {
      video.currentTime = targetTime;
      await waitForEvent(video, 'seeked');
    } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForEvent(video, 'loadeddata');
    }

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      return null;
    }

    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));

    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas, quality);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute('src');
    video.load();
  }
}
