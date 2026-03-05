// 允许的图片 MIME 类型
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/svg+xml',
];

// 允许的文件扩展名
export const ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.avif',
  '.svg',
];

/**
 * 验证内容类型（用于 presign 接口）
 * @param contentType 内容类型字符串
 * @throws Error 如果内容类型无效
 */
export function validateContentType(contentType?: string): void {
  if (!contentType) {
    throw new Error('Content type is required');
  }

  if (!ALLOWED_MIME_TYPES.includes(contentType)) {
    throw new Error(`Content type not allowed: ${contentType}`);
  }
}

// 文件上传限制常量
export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
export const MAX_FILES = 9;
export const MAX_BATCH_SIZE = 100; // 批量操作最大数量限制

/**
 * 验证文件大小（用于 presign 接口）
 * @param size 文件大小（字节）
 * @throws Error 如果文件大小无效
 */
export function validateFileSize(size: number | undefined | null): void {
  if (size === undefined || size === null) {
    throw new Error('File size (size) is required');
  }
  if (size <= 0) {
    throw new Error('File size must be greater than 0');
  }
  if (size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds limit: ${MAX_FILE_SIZE} bytes`);
  }
}
