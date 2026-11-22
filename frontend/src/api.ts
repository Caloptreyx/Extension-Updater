import { axiosInstance } from '@/api/axios.ts';
import type {
  LicenseNeeded,
  Overview,
  RunStarted,
  Settings,
  SettingsUpdate,
  Summary,
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

export const getSettings = async (): Promise<Settings> =>
  (await axiosInstance.get(`${ADMIN_BASE}/settings`)).data.settings;

export const updateSettings = async (settings: SettingsUpdate): Promise<Settings> =>
  (await axiosInstance.put(`${ADMIN_BASE}/settings`, settings)).data.settings;
