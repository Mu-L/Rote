import { randomUUID } from 'crypto';
import { Hono } from 'hono';
import type { User } from '../../drizzle/schema';
import { requireStorageConfig } from '../../middleware/configCheck';
import { authenticateJWT } from '../../middleware/jwtAuth';
import type { StorageConfig, UiConfig } from '../../types/config';
import type { HonoContext, HonoVariables } from '../../types/hono';
import type { UploadResult } from '../../types/main';
import { getConfig, getGlobalConfig } from '../../utils/config';
import {
  deleteAttachment,
  deleteAttachments,
  getAttachmentDetailsByRoteId,
  updateAttachmentsSortOrder,
  upsertAttachmentsByOriginalKey,
} from '../../utils/dbMethods';
import {
  DEFAULT_MAX_VIDEO_UPLOAD_SIZE_MB,
  MAX_BATCH_SIZE,
  MAX_FILES,
  getMediaKindFromContentType,
  inferAttachmentMediaKind,
  isVideoContentType,
  mergeUniqueRoteAttachmentDetails,
  validateContentType,
  validateFileSize,
  validateRoteAttachmentDetails,
} from '../../utils/fileValidation';
import { createResponse, isValidUUID } from '../../utils/main';
import { checkObjectExists, presignPutUrl } from '../../utils/r2';
import { AttachmentPresignZod } from '../../utils/zod';

// 附件相关路由
const attachmentsRouter = new Hono<{ Variables: HonoVariables }>();

const canAlwaysUploadVideo = (role?: string | null) => role === 'admin' || role === 'super_admin';

const canRegularUserUploadVideo = (uiConfig?: UiConfig | null) =>
  uiConfig?.allowUserVideoUpload === true;

const getMaxVideoUploadSizeMB = (uiConfig?: UiConfig | null) => {
  const configured = uiConfig?.maxVideoUploadSizeMB;
  return typeof configured === 'number' && configured > 0
    ? configured
    : DEFAULT_MAX_VIDEO_UPLOAD_SIZE_MB;
};

const getExt = (filename?: string, contentType?: string) => {
  if (filename && filename.includes('.')) return `.${filename.split('.').pop()}`;
  if (!contentType) return '';

  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
  };

  return map[contentType] || '';
};

const extractOriginalUploadUuid = (key?: string) =>
  key?.match(/\/uploads\/([^/.]+)(\.[^.]+)?$/)?.[1] ?? null;

const extractCompressedUuid = (key?: string) =>
  key?.match(/\/compressed\/([^/.]+)\.webp$/)?.[1] ?? null;

const extractPosterUuid = (key?: string) => key?.match(/\/posters\/([^/.]+)\.[^.]+$/)?.[1] ?? null;

// 删除单个附件
attachmentsRouter.delete('/:id', authenticateJWT, async (c: HonoContext) => {
  const user = c.get('user') as User;
  const id = c.req.param('id');

  if (!id || !isValidUUID(id)) {
    throw new Error('Invalid attachment ID');
  }

  const data = await deleteAttachment(id, user.id);
  return c.json(createResponse(data), 200);
});

// 批量删除附件
attachmentsRouter.delete('/', authenticateJWT, async (c: HonoContext) => {
  const user = c.get('user') as User;
  const body = await c.req.json();
  const { ids } = body;

  if (!ids || ids.length === 0) {
    throw new Error('No attachments to delete');
  }

  // 限制批量删除的数量，防止滥用
  if (ids.length > MAX_BATCH_SIZE) {
    throw new Error(`Maximum ${MAX_BATCH_SIZE} attachments can be deleted at once`);
  }

  const data = await deleteAttachments(
    ids.map((id: string) => ({ id })),
    user.id
  );
  return c.json(createResponse(data), 200);
});

// 更新附件排序
attachmentsRouter.put('/sort', authenticateJWT, async (c: HonoContext) => {
  const user = c.get('user') as User;
  const body = await c.req.json();
  const { roteId, attachmentIds } = body as {
    roteId: string;
    attachmentIds: string[];
  };

  if (!roteId || !isValidUUID(roteId)) {
    throw new Error('Invalid rote ID');
  }

  if (!attachmentIds || !Array.isArray(attachmentIds) || attachmentIds.length === 0) {
    throw new Error('Invalid attachment IDs');
  }

  // 限制批量更新的数量，防止滥用
  if (attachmentIds.length > MAX_BATCH_SIZE) {
    throw new Error(`Maximum ${MAX_BATCH_SIZE} attachments can be sorted at once`);
  }

  // 验证所有附件ID格式
  for (const id of attachmentIds) {
    if (!isValidUUID(id)) {
      throw new Error(`Invalid attachment ID: ${id}`);
    }
  }

  const data = await updateAttachmentsSortOrder(user.id, roteId, attachmentIds);
  return c.json(createResponse(data), 200);
});

// 预签名直传（前端直接 PUT 到 R2）
attachmentsRouter.post(
  '/presign',
  authenticateJWT,
  requireStorageConfig,
  async (c: HonoContext) => {
    // 检查是否允许上传文件
    const uiConfig = await getConfig<UiConfig>('ui');
    if (uiConfig && uiConfig.allowUploadFile === false) {
      return c.json(createResponse(null, 'File upload is currently disabled'), 403);
    }

    const user = c.get('user') as User;
    const body = await c.req.json();
    const { files } = body as {
      files: Array<{ filename?: string; contentType?: string; size?: number }>;
    };

    // 验证输入长度和格式
    AttachmentPresignZod.parse(body);

    // 验证文件数量限制（zod 已经验证，但保留作为双重检查）
    if (files.length > MAX_FILES) {
      throw new Error(`Maximum ${MAX_FILES} files allowed`);
    }

    const hasVideo = files.some((f) => isVideoContentType(f.contentType));
    if (hasVideo && !canAlwaysUploadVideo(user.role) && !canRegularUserUploadVideo(uiConfig)) {
      return c.json(
        createResponse(null, 'Video upload is currently disabled for regular users'),
        403
      );
    }

    const maxVideoUploadSizeMB = getMaxVideoUploadSizeMB(uiConfig);

    // 严格验证每个文件的内容类型和大小
    for (const f of files) {
      validateContentType(f.contentType);
      if (isVideoContentType(f.contentType) && canAlwaysUploadVideo(user.role)) {
        continue;
      }
      validateFileSize(f.size, f.contentType, maxVideoUploadSizeMB);
    }

    const results = await Promise.all(
      files.map(async (f) => {
        const uuid = randomUUID();
        const ext = getExt(f.filename, f.contentType);
        const originalKey = `users/${user.id}/uploads/${uuid}${ext}`;
        const mediaKind = getMediaKindFromContentType(f.contentType);
        const original = await presignPutUrl(originalKey, f.contentType || undefined, 15 * 60);

        const result: Record<string, any> = {
          uuid,
          original: {
            key: originalKey,
            putUrl: original.putUrl,
            url: original.url,
            contentType: f.contentType,
          },
        };

        if (mediaKind === 'image') {
          const compressedKey = `users/${user.id}/compressed/${uuid}.webp`;
          const compressed = await presignPutUrl(compressedKey, 'image/webp', 15 * 60);
          result.compressed = {
            key: compressedKey,
            putUrl: compressed.putUrl,
            url: compressed.url,
            contentType: 'image/webp',
          };
        }

        if (mediaKind === 'video') {
          const posterKey = `users/${user.id}/posters/${uuid}.jpg`;
          const poster = await presignPutUrl(posterKey, 'image/jpeg', 15 * 60);
          result.poster = {
            key: posterKey,
            putUrl: poster.putUrl,
            url: poster.url,
            contentType: 'image/jpeg',
          };
        }

        return result;
      })
    );

    return c.json(createResponse({ items: results }), 200);
  }
);

// 完成回调：将已上传对象入库（可选绑定 noteId）
attachmentsRouter.post(
  '/finalize',
  authenticateJWT,
  requireStorageConfig,
  async (c: HonoContext) => {
    const user = c.get('user') as User;
    const uiConfig = await getConfig<UiConfig>('ui');
    const body = await c.req.json();
    const { attachments, noteId } = body as {
      attachments: Array<{
        uuid: string;
        originalKey: string;
        compressedKey?: string;
        posterKey?: string;
        size?: number;
        mimetype?: string;
        hash?: string;
        noteId?: string;
      }>;
      noteId?: string;
    };

    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
      throw new Error('No attachments to finalize');
    }

    // 限制批量完成的数量，防止滥用
    if (attachments.length > MAX_BATCH_SIZE) {
      throw new Error(`Maximum ${MAX_BATCH_SIZE} attachments can be finalized at once`);
    }

    // 简单的所有权校验：Key 必须在当前用户前缀下
    const prefix = `users/${user.id}/`;
    const invalid = attachments.find(
      (a) =>
        !a.originalKey?.startsWith(prefix) ||
        (a.compressedKey !== undefined && !a.compressedKey.startsWith(prefix)) ||
        (a.posterKey !== undefined && !a.posterKey.startsWith(prefix))
    );
    if (invalid) {
      throw new Error('Invalid object key');
    }

    const maxVideoUploadSizeMB = getMaxVideoUploadSizeMB(uiConfig);

    // 验证 mimetype（如果提供）
    for (const a of attachments) {
      if (a.mimetype) {
        validateContentType(a.mimetype);
        if (isVideoContentType(a.mimetype) && canAlwaysUploadVideo(user.role)) {
          continue;
        }
        validateFileSize(a.size, a.mimetype, maxVideoUploadSizeMB);
      }
    }

    const hasVideo = attachments.some(
      (a) =>
        inferAttachmentMediaKind({
          mimetype: a.mimetype,
          compressedKey: a.compressedKey,
          posterKey: a.posterKey,
          key: a.originalKey,
        }) === 'video'
    );
    if (hasVideo && !canAlwaysUploadVideo(user.role) && !canRegularUserUploadVideo(uiConfig)) {
      return c.json(
        createResponse(null, 'Video upload is currently disabled for regular users'),
        403
      );
    }

    // 验证文件存在性和 UUID 一致性
    const validationErrors: string[] = [];
    const validAttachments: typeof attachments = [];

    for (const a of attachments) {
      const mediaKind = inferAttachmentMediaKind({
        mimetype: a.mimetype,
        compressedKey: a.compressedKey,
        posterKey: a.posterKey,
        key: a.originalKey,
      });

      const normalizedAttachment = { ...a };

      // 1. 验证原图文件是否存在
      const originalExists = await checkObjectExists(a.originalKey);
      if (!originalExists) {
        validationErrors.push(`Original file not found: ${a.originalKey} (uuid: ${a.uuid})`);
        continue;
      }

      const originalUuid = extractOriginalUploadUuid(a.originalKey);
      if (!originalUuid) {
        validationErrors.push(
          `Invalid original key format for uuid validation: originalKey=${a.originalKey}`
        );
        continue;
      }

      if (originalUuid !== a.uuid) {
        validationErrors.push(
          `UUID mismatch: request uuid '${a.uuid}' does not match originalKey uuid '${originalUuid}'`
        );
        continue;
      }

      // 2. 视频不接受 compressedKey
      if (mediaKind === 'video' && normalizedAttachment.compressedKey) {
        validationErrors.push(
          `Videos cannot include compressedKey: ${a.originalKey} (uuid: ${a.uuid})`
        );
        continue;
      }

      if (mediaKind === 'image' && normalizedAttachment.posterKey) {
        validationErrors.push(
          `Images cannot include posterKey: ${a.originalKey} (uuid: ${a.uuid})`
        );
        normalizedAttachment.posterKey = undefined;
      }

      if (mediaKind === 'image' && normalizedAttachment.compressedKey) {
        const compressedExists = await checkObjectExists(normalizedAttachment.compressedKey);
        if (!compressedExists) {
          validationErrors.push(
            `Compressed file not found: ${normalizedAttachment.compressedKey} (uuid: ${a.uuid})`
          );
          normalizedAttachment.compressedKey = undefined;
        } else {
          const compressedUuid = extractCompressedUuid(normalizedAttachment.compressedKey);

          if (!compressedUuid) {
            validationErrors.push(
              `Invalid key format for uuid validation: originalKey=${a.originalKey}, compressedKey=${normalizedAttachment.compressedKey}`
            );
            normalizedAttachment.compressedKey = undefined;
          } else if (originalUuid !== compressedUuid) {
            validationErrors.push(
              `UUID mismatch: originalKey contains uuid '${originalUuid}', but compressedKey contains uuid '${compressedUuid}'`
            );
            normalizedAttachment.compressedKey = undefined;
          }
        }
      }

      if (mediaKind === 'video' && normalizedAttachment.posterKey) {
        const posterExists = await checkObjectExists(normalizedAttachment.posterKey);
        if (!posterExists) {
          validationErrors.push(
            `Poster file not found: ${normalizedAttachment.posterKey} (uuid: ${a.uuid})`
          );
          normalizedAttachment.posterKey = undefined;
        } else {
          const posterUuid = extractPosterUuid(normalizedAttachment.posterKey);
          if (!posterUuid) {
            validationErrors.push(
              `Invalid key format for uuid validation: originalKey=${a.originalKey}, posterKey=${normalizedAttachment.posterKey}`
            );
            normalizedAttachment.posterKey = undefined;
          } else if (originalUuid !== posterUuid) {
            validationErrors.push(
              `UUID mismatch: originalKey contains uuid '${originalUuid}', but posterKey contains uuid '${posterUuid}'`
            );
            normalizedAttachment.posterKey = undefined;
          }
        }
      }

      if (!mediaKind) {
        validationErrors.push(
          `Unsupported attachment media type: ${a.originalKey} (uuid: ${a.uuid})`
        );
        continue;
      }

      // 所有验证通过
      validAttachments.push(normalizedAttachment);
    }

    // 如果没有有效的附件，返回错误
    if (validAttachments.length === 0) {
      // 如果有验证错误，返回详细错误信息
      if (validationErrors.length > 0) {
        const errorMessage =
          validationErrors.length === 1
            ? validationErrors[0]
            : `${validationErrors.length} validation error(s): ${validationErrors.join('; ')}`;
        throw new Error(errorMessage);
      }
      throw new Error('No valid attachments to finalize after validation');
    }

    // 如果有验证错误但仍有有效附件，记录警告（部分成功）
    if (validationErrors.length > 0) {
      console.warn(
        `Some attachments failed validation (${validationErrors.length} error(s)), but ${validAttachments.length} attachment(s) will be finalized:`,
        validationErrors
      );
    }

    if (noteId) {
      const currentAttachments = await getAttachmentDetailsByRoteId(noteId);
      const pendingAttachments = validAttachments.map((a) => ({
        details: {
          key: a.originalKey,
          mimetype: a.mimetype || null,
          mediaKind: inferAttachmentMediaKind({
            mimetype: a.mimetype || null,
            compressedKey: a.compressedKey,
            posterKey: a.posterKey,
          }),
          compressKey: a.compressedKey,
          posterKey: a.posterKey,
        },
      }));
      validateRoteAttachmentDetails(
        mergeUniqueRoteAttachmentDetails(currentAttachments, pendingAttachments)
      );
    }

    const uploads: UploadResult[] = validAttachments.map((a) => {
      const storageConfig = getGlobalConfig<StorageConfig>('storage');
      const urlPrefix = storageConfig?.urlPrefix;
      const oUrl = `${urlPrefix}/${a.originalKey}`;
      const mediaKind = inferAttachmentMediaKind({
        mimetype: a.mimetype || null,
        compressedKey: a.compressedKey,
        posterKey: a.posterKey,
      });
      const cUrl =
        mediaKind === 'image' && a.compressedKey ? `${urlPrefix}/${a.compressedKey}` : null;
      const pUrl = mediaKind === 'video' && a.posterKey ? `${urlPrefix}/${a.posterKey}` : null;
      const baseDetails: any = {
        size: a.size || 0,
        mimetype: a.mimetype || null,
        mediaKind,
        mtime: new Date().toISOString(),
        key: a.originalKey,
      };
      if (a.compressedKey) baseDetails.compressKey = a.compressedKey;
      if (a.posterKey) baseDetails.posterKey = a.posterKey;
      if (a.hash) baseDetails.hash = a.hash;

      return {
        url: oUrl,
        compressUrl: cUrl,
        posterUrl: pUrl,
        details: baseDetails,
      };
    });

    const data = await upsertAttachmentsByOriginalKey(
      user.id,
      (noteId as string | undefined) || undefined,
      uploads
    );

    return c.json(createResponse(data), 201);
  }
);

export default attachmentsRouter;
