import { axiosInstance } from '@/api/axios.ts';
import type {
  LicenseNeeded,
  Overview,
  RunStarted,
  SettingsResponse,
  SettingsUpdate,
  Summary,
  TokenTestResult,
  UpdateRequest,
} from './lib/types.ts';

// The backend's payloads keep their snake_case names: the panel's axios instance does not rename keys.

export const PACKAGE = 'dev.caloptreyx.updater';
export const ADMIN_BASE = `/api/admin/extensions/${PACKAGE}`;
/** Below the panel's /admin router. */
export const PAGE_PATH = '/admin/extension-updates';

export const getOverview = async (): Promise<Overview> => (await axiosInstance.get(`${ADMIN_BASE}/overview`)).data;

export const getSummary = async (): Promise<Summary> => (await axiosInstance.get(`${ADMIN_BASE}/summary`)).data;

/** Checks GitHub now (throttled by the backend) and returns the fresh overview. */
export const checkNow = async (): Promise<Overview> => (await axiosInstance.post(`${ADMIN_BASE}/check`)).data;

export type UpdateResult =
  | { type: 'started'; started: RunStarted }
  | { type: 'needs_license'; licenses: LicenseNeeded[] };

/** Installs the given releases in one rebuild; a 409 lists the licenses to accept first. */
export const startUpdate = async (request: UpdateRequest): Promise<UpdateResult> => {
  const response = await axiosInstance.post(`${ADMIN_BASE}/update`, request, {
    validateStatus: (status) => (status >= 200 && status < 300) || status === 409,
  });
  if (response.status === 409 && Array.isArray(response.data?.needs_license)) {
    return { type: 'needs_license', licenses: response.data.needs_license };
  }
  if (response.status === 409) {
    // a 409 without licenses is a plain error (another run is building, ...)
    throw Object.assign(new Error(response.statusText), { response });
  }
  return { type: 'started', started: response.data };
};

export const rollback = async (packageName: string): Promise<RunStarted> =>
  (await axiosInstance.post(`${ADMIN_BASE}/rollback`, { package_name: packageName })).data;

/** Turns an extension's updates on or off. */
export const setUpdates = async (packageName: string, enabled: boolean): Promise<void> => {
  await axiosInstance.put(`${ADMIN_BASE}/updates`, { package_name: packageName, enabled });
};

/** Skips a specific release version for an extension, or clears the skip when `version` is null. */
export const setSkippedVersion = async (packageName: string, version: string | null): Promise<void> => {
  await axiosInstance.put(`${ADMIN_BASE}/skip`, { package_name: packageName, version });
};

/** Tests a provided GitHub token without saving it, or the currently stored token when omitted/null. */
export const testToken = async (githubToken?: string | null): Promise<TokenTestResult> =>
  (await axiosInstance.post(`${ADMIN_BASE}/test-token`, { github_token: githubToken ?? null })).data;

/** Tests a Discord webhook URL without saving it, or tests the currently configured webhook when omitted/null. */
export const testDiscordWebhook = async (webhookUrl?: string | null): Promise<{ ok: boolean }> =>
  (await axiosInstance.post(`${ADMIN_BASE}/test-discord-webhook`, { webhook_url: webhookUrl ?? null })).data;

export const getSettings = async (): Promise<SettingsResponse> =>
  (await axiosInstance.get(`${ADMIN_BASE}/settings`)).data;

export const updateSettings = async (settings: SettingsUpdate): Promise<SettingsResponse> =>
  (await axiosInstance.put(`${ADMIN_BASE}/settings`, settings)).data;
