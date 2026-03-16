import { get, post, put } from './api';

// 设置相关 API 接口

// 获取系统配置状态
export const getConfigStatus = () => get('/site/config-status');

// 获取站点状态
export const getSiteStatus = () => get('/site/status');

// 获取系统初始化状态（管理员）
export const getSystemStatus = () => get('/admin/status');

// 获取所有配置（管理员）
export const getAllSettings = (group?: string) =>
  get(`/admin/settings${group ? `?group=${group}` : ''}`);

// 更新配置（管理员）
export const updateSettings = (group: string, config: any) =>
  put('/admin/settings', { group, config });

// 测试配置连接（管理员）
export const testConfig = (type: string, config: any) =>
  post('/admin/settings/test', { type, config });

// 存储配置类型
export interface StorageConfigForTest {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  urlPrefix: string;
  region?: string;
}

// 测试存储配置的通用函数
export async function testStorageConnection(
  config: StorageConfigForTest | null | undefined
): Promise<{
  success: boolean;
  message?: string;
  probeUrl?: string;
  urlPrefixProbeUrl?: string;
}> {
  // 验证必填字段
  if (
    !config ||
    !config.endpoint?.trim() ||
    !config.bucket?.trim() ||
    !config.accessKeyId?.trim() ||
    !config.secretAccessKey?.trim() ||
    !config.urlPrefix?.trim()
  ) {
    return {
      success: false,
      message: 'Please fill in all required fields',
    };
  }

  try {
    const response = await testConfig('storage', config);

    if (response.data?.success) {
      return {
        success: true,
        message: response.data?.message || 'Storage connection test successful',
        probeUrl: response.data?.details?.probeUrl,
        urlPrefixProbeUrl: response.data?.details?.urlPrefixProbeUrl,
      };
    } else {
      return {
        success: false,
        message: response.data?.message || 'Unknown error',
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: error?.response?.data?.message || error?.message || 'Unknown error',
    };
  }
}

/**
 * 从浏览器侧探测 CORS 是否正确配置。
 * 发送一个 GET 请求到 presigned URL，如果 CORS 未配置则浏览器 preflight 会失败。
 * 返回 { ok: true } 或 { ok: false, reason: string }。
 */
export async function probeCors(
  url: string
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      mode: 'cors',
    });
    // 任何 HTTP 响应（包括 403/404）说明 CORS 允许了这个请求
    // 404 是正常的因为 probe key 不存在
    if (resp.status === 403 || resp.status === 404 || (resp.status >= 200 && resp.status < 500)) {
      return { ok: true };
    }
    return { ok: true };
  } catch (_err: any) {
    // fetch 在 CORS 被阻止时会抛 TypeError
    return {
      ok: false,
      reason:
        'CORS preflight failed. The browser cannot access storage directly. ' +
        'Please check that your S3/R2 bucket CORS configuration allows the current origin: ' +
        window.location.origin,
    };
  }
}

// 重新生成安全密钥（超级管理员）
export const regenerateKeys = () => post('/admin/settings/regenerate-keys');

// 检测当前 URL（管理员）
export const detectUrls = () => get('/admin/settings/detect-urls');

// 更新 URL 配置（管理员）
export const updateUrls = (frontendUrl?: string) =>
  post('/admin/settings/update-urls', { frontendUrl });

// 系统初始化向导
export const setupSystem = (setupData: any) => post('/admin/setup', setupData);

// 刷新配置缓存
export const refreshConfigCache = () => post('/admin/refresh-cache');
