import {
  faArrowsRotate,
  faBoxOpen,
  faCircleInfo,
  faClockRotateLeft,
  faExclamationTriangle,
  faGear,
  faMagnifyingGlass,
  faPuzzlePiece,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { httpErrorToHuman } from '@/api/axios.ts';
import ActionBar from '@/elements/ActionBar.tsx';
import Button from '@/elements/buttons/Button.tsx';
import CloseButton from '@/elements/buttons/CloseButton.tsx';
import AdminContentContainer from '@/elements/containers/AdminContentContainer.tsx';
import Badge from '@/elements/data-display/Badge.tsx';
import Card from '@/elements/data-display/Card.tsx';
import Alert from '@/elements/feedback/Alert.tsx';
import Spinner from '@/elements/feedback/Spinner.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import Group from '@/elements/layout/Group.tsx';
import SegmentedControl from '@/elements/layout/SegmentedControl.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import Tabs from '@/elements/layout/Tabs.tsx';
import ConfirmationModal from '@/elements/modals/ConfirmationModal.tsx';
import FormattedTimestamp from '@/elements/time/FormattedTimestamp.tsx';
import Text from '@/elements/typography/Text.tsx';
import { safeLocalStorageGet, safeLocalStorageSet } from '@/lib/safeStorage.ts';
import BuildLogsModal from '@/pages/admin/extensions/modals/BuildLogsModal.tsx';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import type { Entry, LicenseNeeded, Overview, Run, UpdateRequest } from '../lib/types.ts';
import { checkNow, getOverview, PACKAGE, rollback, setSkippedVersion, setUpdates, startUpdate } from '../api.ts';
import ConfirmUpdateModal, { type ConfirmUpdateTarget } from '../components/ConfirmUpdateModal.tsx';
import EntryCard from '../components/EntryCard.tsx';
import LicenseModal from '../components/LicenseModal.tsx';
import RunHistory from '../components/RunHistory.tsx';
import { BuildCard, RunResult } from '../components/RunStatus.tsx';
import SettingsForm from '../components/SettingsForm.tsx';
import { summaryKey } from '../components/UpdatesBanner.tsx';
import {
  activeBuildId,
  filterAvailableEntries,
  filterInstalledEntries,
  installableEntries,
  isBuilding,
  isLatestSkipped,
  isQuotaLow,
  isRateLimited,
  lastFinishedRun,
  packagesOf,
  retryPackages,
  runResultDismissKey,
  selectedEntries,
  updatableEntries,
  type InstalledFilter,
} from '../lib/status.ts';
import { useExtTranslations } from '../translations.ts';

const overviewKey = [PACKAGE, 'overview'] as const;

const POLL_BUILDING_MS = 4000;
const POLL_IDLE_MS = 60_000;

type TabValue = 'installed' | 'available' | 'history' | 'settings';
const VALID_TABS: readonly TabValue[] = ['installed', 'available', 'history', 'settings'];

function parseTab(raw: string | null): TabValue {
  return VALID_TABS.includes(raw as TabValue) ? (raw as TabValue) : 'installed';
}

export default function UpdaterPage() {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const canRead = useAdminCan('extensions.read');
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseTab(searchParams.get('tab'));

  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: getOverview,
    enabled: canRead,
    // the panel restarts after a successful build; failed requests keep the last overview and polling goes on
    refetchInterval: (query) => (query.state.data && isBuilding(query.state.data) ? POLL_BUILDING_MS : POLL_IDLE_MS),
  });

  const [checking, setChecking] = useState(false);
  /** The button whose request is pending: a package name, 'all', 'batch', or 'retry:<id>'. */
  const [pending, setPending] = useState<string | null>(null);
  /** The package whose pause/skip action is pending. */
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmUpdateTarget | null>(null);
  const [licenses, setLicenses] = useState<{ needed: LicenseNeeded[]; request: UpdateRequest } | null>(null);
  const [rollbackEntry, setRollbackEntry] = useState<Entry | null>(null);
  const [log, setLog] = useState<{ opened: boolean; buildId: number | null }>({ opened: false, buildId: null });
  const [dismissedResultKey, setDismissedResultKey] = useState<string | null>(null);

  const [installedSearch, setInstalledSearch] = useState('');
  const [installedFilter, setInstalledFilter] = useState<InstalledFilter>('all');
  const [availableSearch, setAvailableSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const data = overview.data;
  const building = data ? isBuilding(data) : false;
  const newestFinished = data && !building ? lastFinishedRun(data.runs) : null;

  // Refresh banner/card when an observed build finishes, and toast on success
  const wasBuilding = useRef(building);
  useEffect(() => {
    if (wasBuilding.current && !building) {
      queryClient.invalidateQueries({ queryKey: summaryKey });
      if (newestFinished?.state === 'succeeded') {
        addToast(t('actions.finishedToast', {}), 'success');
      }
    }
    wasBuilding.current = building;
  }, [building, newestFinished?.state, queryClient, addToast, t]);

  const setTab = (value: string | null) => {
    const next = parseTab(value);
    const params = new URLSearchParams(searchParams);
    if (next === 'installed') {
      params.delete('tab');
    } else {
      params.set('tab', next);
    }
    setSearchParams(params, { replace: true });
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: [PACKAGE] });

  const sendUpdate = async (request: UpdateRequest) => {
    const result = await startUpdate(request);
    if (result.type === 'needs_license') {
      setConfirmTarget(null);
      setLicenses({ needed: result.licenses, request });
      return;
    }
    setConfirmTarget(null);
    setLicenses(null);
    setSelected(new Set());
    addToast(t('actions.started', {}), 'success');
    await refresh();
  };

  const runDirect = (key: string, request: UpdateRequest) => {
    setPending(key);
    sendUpdate(request)
      .catch((error) => addToast(httpErrorToHuman(error), 'error'))
      .finally(() => setPending(null));
  };

  const openConfirm = (entries: Entry[], force: boolean) => {
    setConfirmTarget({
      entries,
      request: {
        packages: packagesOf(entries),
        accept_licenses: [],
        force,
      },
    });
  };

  const doCheck = () => {
    setChecking(true);
    checkNow()
      .then((fresh: Overview) => {
        queryClient.setQueryData(overviewKey, fresh);
        queryClient.invalidateQueries({ queryKey: summaryKey });
        addToast(t('actions.checked', {}), 'success');
      })
      .catch((error) => addToast(httpErrorToHuman(error), 'error'))
      .finally(() => setChecking(false));
  };

  const openLog = (buildId: number | null) => setLog({ opened: true, buildId });

  const toggleUpdates = (entry: Entry, enabled: boolean) => {
    setBusyAction(entry.package_name);
    setUpdates(entry.package_name, enabled)
      .then(async () => {
        addToast(t(enabled ? 'actions.updatesTurnedOn' : 'actions.updatesTurnedOff', { name: entry.name }), 'success');
        await refresh();
      })
      .catch((error) => addToast(httpErrorToHuman(error), 'error'))
      .finally(() => setBusyAction(null));
  };

  const skipVersion = (entry: Entry, version: string | null) => {
    setBusyAction(entry.package_name);
    setSkippedVersion(entry.package_name, version)
      .then(async () => {
        addToast(
          version
            ? t('actions.versionSkipped', { name: entry.name, version })
            : t('actions.skipCleared', { name: entry.name }),
          'success',
        );
        await refresh();
      })
      .catch((error) => addToast(httpErrorToHuman(error), 'error'))
      .finally(() => setBusyAction(null));
  };

  const toggleSelect = (packageName: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(packageName);
      else next.delete(packageName);
      return next;
    });
  };

  const retryRun = (run: Run) => {
    runDirect(`retry:${run.id}`, { packages: retryPackages(run), accept_licenses: [], force: true });
  };

  const manageable = !!data && data.management.available && data.can_manage;
  const locked = building || pending !== null;

  const updatable = useMemo(() => (data ? updatableEntries(data.extensions) : []), [data]);
  const installedAll = useMemo(() => (data ? data.extensions.filter((entry) => entry.installed) : []), [data]);
  const availableAll = useMemo(() => (data ? installableEntries(data.extensions) : []), [data]);
  const filteredInstalled = useMemo(
    () => (data ? filterInstalledEntries(data.extensions, installedFilter, installedSearch) : []),
    [data, installedFilter, installedSearch],
  );
  const filteredAvailable = useMemo(
    () => (data ? filterAvailableEntries(data.extensions, availableSearch) : []),
    [data, availableSearch],
  );
  const activeSelected = useMemo(() => (data ? selectedEntries(data.extensions, selected) : []), [data, selected]);

  const showGroupedInstalled = installedFilter === 'all' && installedSearch.trim() === '';
  const offeredInstalledGroup = useMemo(
    () =>
      showGroupedInstalled
        ? filteredInstalled.filter(
            (entry) => entry.status === 'update_available' && entry.updates_enabled && !isLatestSkipped(entry),
          )
        : [],
    [filteredInstalled, showGroupedInstalled],
  );
  const otherInstalledGroup = useMemo(() => {
    if (!showGroupedInstalled || offeredInstalledGroup.length === 0) return [];
    const offeredSet = new Set(offeredInstalledGroup.map((entry) => entry.package_name));
    return filteredInstalled.filter((entry) => !offeredSet.has(entry.package_name));
  }, [filteredInstalled, offeredInstalledGroup, showGroupedInstalled]);

  const finishedKey = newestFinished ? runResultDismissKey(newestFinished.id) : null;
  const showFinishedAlert = Boolean(
    newestFinished && finishedKey && dismissedResultKey !== finishedKey && safeLocalStorageGet(finishedKey) === null,
  );

  const dismissFinishedAlert = () => {
    if (!finishedKey) return;
    safeLocalStorageSet(finishedKey, '1');
    setDismissedResultKey(finishedKey);
  };

  const contentRight = data && (
    <Group gap='xs'>
      <Button
        variant='default'
        leftSection={<FontAwesomeIcon icon={faArrowsRotate} />}
        loading={checking || data.checking}
        onClick={doCheck}
      >
        {t('actions.checkNow', {})}
      </Button>
      {manageable && updatable.length > 0 && (
        <Button loading={pending === 'all'} disabled={locked} onClick={() => openConfirm(updatable, false)}>
          {t('actions.updateAll', { count: updatable.length })}
        </Button>
      )}
    </Group>
  );

  return (
    <AdminContentContainer title={t('title', {})} subtitle={t('subtitle', {})} contentRight={contentRight}>
      {!data ? (
        overview.error ? (
          <Alert color='red' icon={<FontAwesomeIcon icon={faExclamationTriangle} />}>
            {t('errors.load', { error: httpErrorToHuman(overview.error) })}
          </Alert>
        ) : (
          <Spinner.Centered />
        )
      ) : (
        <Stack gap='md'>
          <Notices overview={data} />

          {building && (
            <BuildCard
              run={data.runs.find((r) => r.state === 'building') ?? null}
              supervisor={data.supervisor}
              restarting={overview.isError}
              onViewLog={data.can_manage ? () => openLog(activeBuildId(data)) : null}
            />
          )}

          {showFinishedAlert && newestFinished && (
            <RunResult
              run={newestFinished}
              onViewLog={
                data.can_manage && newestFinished.build_id !== null ? () => openLog(newestFinished.build_id) : null
              }
              onRetry={
                manageable && newestFinished.state === 'failed' && newestFinished.kind === 'update'
                  ? () => retryRun(newestFinished)
                  : null
              }
              onDismiss={dismissFinishedAlert}
              retrying={pending === `retry:${newestFinished.id}`}
              locked={locked}
            />
          )}

          <Tabs value={activeTab} onChange={setTab}>
            <Tabs.List mb='md'>
              <Tabs.Tab
                value='installed'
                leftSection={<FontAwesomeIcon icon={faPuzzlePiece} size='sm' />}
                rightSection={
                  updatable.length > 0 ? (
                    <Badge size='xs' color='blue' variant='filled' circle>
                      {updatable.length}
                    </Badge>
                  ) : undefined
                }
              >
                {t('tabs.installed', {})}
              </Tabs.Tab>

              <Tabs.Tab
                value='available'
                leftSection={<FontAwesomeIcon icon={faBoxOpen} size='sm' />}
                rightSection={
                  availableAll.length > 0 ? (
                    <Badge size='xs' color='gray' variant='light'>
                      {availableAll.length}
                    </Badge>
                  ) : undefined
                }
              >
                {t('tabs.available', {})}
              </Tabs.Tab>

              <Tabs.Tab
                value='history'
                leftSection={<FontAwesomeIcon icon={faClockRotateLeft} size='sm' />}
                rightSection={
                  newestFinished?.state === 'failed' ? (
                    <span className='inline-block h-2 w-2 rounded-full bg-red-500' aria-hidden='true' />
                  ) : undefined
                }
              >
                {t('tabs.history', {})}
              </Tabs.Tab>

              <Tabs.Tab value='settings' leftSection={<FontAwesomeIcon icon={faGear} size='sm' />}>
                {t('tabs.settings', {})}
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value='installed'>
              <Stack gap='md'>
                <div className='flex flex-col md:flex-row gap-2 md:items-center justify-between'>
                  <TextInput
                    className='w-full md:max-w-xs'
                    placeholder={t('filters.searchPlaceholder', {})}
                    leftSection={<FontAwesomeIcon icon={faMagnifyingGlass} size='xs' />}
                    rightSection={
                      installedSearch ? <CloseButton size='sm' onClick={() => setInstalledSearch('')} /> : undefined
                    }
                    value={installedSearch}
                    onChange={(event) => setInstalledSearch(event.currentTarget.value)}
                  />
                  <SegmentedControl
                    size='xs'
                    value={installedFilter}
                    onChange={(value) => setInstalledFilter(value as InstalledFilter)}
                    data={[
                      { value: 'all', label: t('filters.all', {}) },
                      { value: 'updates', label: t('filters.updates', { count: updatable.length }) },
                      { value: 'paused_skipped', label: t('filters.pausedSkipped', {}) },
                      { value: 'needs_panel', label: t('filters.needsPanel', {}) },
                    ]}
                  />
                </div>

                {installedAll.length === 0 ? (
                  <Card>
                    <Text size='sm' c='dimmed'>
                      {t('list.none', {})}
                    </Text>
                  </Card>
                ) : filteredInstalled.length === 0 ? (
                  <Card>
                    <Text size='sm' c='dimmed'>
                      {t('filters.noMatches', {})}
                    </Text>
                  </Card>
                ) : showGroupedInstalled && offeredInstalledGroup.length > 0 ? (
                  <Stack gap='lg'>
                    <Stack gap='xs'>
                      <Text size='xs' fw={600} c='dimmed' tt='uppercase'>
                        {t('sections.updatesAvailable', {})} ({offeredInstalledGroup.length})
                      </Text>
                      <EntryList
                        entries={offeredInstalledGroup}
                        manageable={manageable}
                        canToggle={data.can_manage}
                        locked={locked}
                        pending={pending}
                        busyAction={busyAction}
                        selected={selected}
                        onToggleSelect={toggleSelect}
                        onInstall={(entry) => openConfirm([entry], false)}
                        onForceInstall={(entry) => openConfirm([entry], true)}
                        onRollback={setRollbackEntry}
                        onToggleUpdates={toggleUpdates}
                        onSkipVersion={skipVersion}
                      />
                    </Stack>

                    {otherInstalledGroup.length > 0 && (
                      <Stack gap='xs'>
                        <Text size='xs' fw={600} c='dimmed' tt='uppercase'>
                          {t('sections.upToDateAndOthers', {})} ({otherInstalledGroup.length})
                        </Text>
                        <EntryList
                          entries={otherInstalledGroup}
                          manageable={manageable}
                          canToggle={data.can_manage}
                          locked={locked}
                          pending={pending}
                          busyAction={busyAction}
                          selected={selected}
                          onToggleSelect={toggleSelect}
                          onInstall={(entry) => openConfirm([entry], false)}
                          onForceInstall={(entry) => openConfirm([entry], true)}
                          onRollback={setRollbackEntry}
                          onToggleUpdates={toggleUpdates}
                          onSkipVersion={skipVersion}
                        />
                      </Stack>
                    )}
                  </Stack>
                ) : (
                  <EntryList
                    entries={filteredInstalled}
                    manageable={manageable}
                    canToggle={data.can_manage}
                    locked={locked}
                    pending={pending}
                    busyAction={busyAction}
                    selected={selected}
                    onToggleSelect={toggleSelect}
                    onInstall={(entry) => openConfirm([entry], false)}
                    onForceInstall={(entry) => openConfirm([entry], true)}
                    onRollback={setRollbackEntry}
                    onToggleUpdates={toggleUpdates}
                    onSkipVersion={skipVersion}
                  />
                )}
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value='available'>
              <Stack gap='md'>
                <TextInput
                  className='w-full md:max-w-xs'
                  placeholder={t('filters.searchPlaceholder', {})}
                  leftSection={<FontAwesomeIcon icon={faMagnifyingGlass} size='xs' />}
                  rightSection={
                    availableSearch ? <CloseButton size='sm' onClick={() => setAvailableSearch('')} /> : undefined
                  }
                  value={availableSearch}
                  onChange={(event) => setAvailableSearch(event.currentTarget.value)}
                />

                {availableAll.length === 0 ? (
                  <Card>
                    <Text size='sm' c='dimmed'>
                      {t('list.noneAvailable', {})}
                    </Text>
                  </Card>
                ) : filteredAvailable.length === 0 ? (
                  <Card>
                    <Text size='sm' c='dimmed'>
                      {t('filters.noMatches', {})}
                    </Text>
                  </Card>
                ) : (
                  <EntryList
                    entries={filteredAvailable}
                    manageable={manageable}
                    canToggle={data.can_manage}
                    locked={locked}
                    pending={pending}
                    busyAction={busyAction}
                    selected={selected}
                    onToggleSelect={toggleSelect}
                    onInstall={(entry) => openConfirm([entry], false)}
                    onForceInstall={(entry) => openConfirm([entry], true)}
                    onRollback={setRollbackEntry}
                    onToggleUpdates={toggleUpdates}
                    onSkipVersion={skipVersion}
                  />
                )}
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value='history'>
              <RunHistory
                runs={data.runs}
                canManage={data.can_manage}
                manageable={manageable}
                locked={locked}
                pending={pending}
                onViewLog={openLog}
                onRetry={retryRun}
              />
            </Tabs.Panel>

            <Tabs.Panel value='settings'>
              <Card>
                <SettingsForm rateLimit={data.rate_limit} timezone={data.timezone} />
              </Card>
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}

      <ActionBar opened={manageable && activeSelected.length > 0 && !building}>
        <Text size='sm' fw={600} className='self-center px-1'>
          {t('selection.count', { count: activeSelected.length })}
        </Text>
        <Button size='xs' disabled={locked} onClick={() => openConfirm(activeSelected, false)}>
          {t('selection.apply', {})}
        </Button>
        <Button size='xs' variant='default' onClick={() => setSelected(new Set())}>
          {t('selection.clear', {})}
        </Button>
      </ActionBar>

      <ConfirmUpdateModal
        opened={confirmTarget !== null}
        onClose={() => setConfirmTarget(null)}
        target={confirmTarget}
        onConfirm={sendUpdate}
      />

      <LicenseModal
        opened={licenses !== null}
        onClose={() => setLicenses(null)}
        licenses={licenses?.needed ?? []}
        onAccept={async () => {
          if (!licenses) return;
          const accepted = licenses.needed.map((license) => license.package_name);
          await sendUpdate({
            ...licenses.request,
            accept_licenses: [...new Set([...licenses.request.accept_licenses, ...accepted])],
          });
        }}
      />

      <ConfirmationModal
        opened={rollbackEntry !== null}
        onClose={() => setRollbackEntry(null)}
        title={t('rollback.title', {})}
        confirm={t('actions.rollback', { version: rollbackEntry?.rollback?.version ?? '' })}
        confirmColor='orange'
        onConfirmed={async () => {
          if (!rollbackEntry) return;
          await rollback(rollbackEntry.package_name);
          setRollbackEntry(null);
          addToast(t('actions.started', {}), 'success');
          await refresh();
        }}
      >
        {t('rollback.content', {
          name: rollbackEntry?.name ?? '',
          version: rollbackEntry?.rollback?.version ?? '',
        })}
      </ConfirmationModal>

      <BuildLogsModal
        opened={log.opened}
        onClose={() => setLog((current) => ({ ...current, opened: false }))}
        buildId={log.buildId}
      />
    </AdminContentContainer>
  );
}

function EntryList({
  entries,
  pending,
  busyAction,
  selected,
  ...props
}: {
  entries: Entry[];
  manageable: boolean;
  canToggle: boolean;
  locked: boolean;
  pending: string | null;
  busyAction: string | null;
  selected: ReadonlySet<string>;
  onToggleSelect: (packageName: string, checked: boolean) => void;
  onInstall: (entry: Entry) => void;
  onForceInstall: (entry: Entry) => void;
  onRollback: (entry: Entry) => void;
  onToggleUpdates: (entry: Entry, enabled: boolean) => void;
  onSkipVersion: (entry: Entry, version: string | null) => void;
}) {
  return (
    <Stack gap='xs'>
      {entries.map((entry) => (
        <EntryCard
          key={entry.package_name}
          entry={entry}
          loading={pending === entry.package_name}
          busyAction={busyAction === entry.package_name}
          selected={selected.has(entry.package_name)}
          {...props}
        />
      ))}
    </Stack>
  );
}

/** Subtle metadata strip + actionable notices (quota only surfaced when rate-limited or remaining < 15). */
function Notices({ overview }: { overview: Overview }) {
  const { t } = useExtTranslations();
  const { management, rate_limit: rateLimit } = overview;
  const resetTime = rateLimit ? new Date(rateLimit.reset * 1000) : null;
  const rateLimited = isRateLimited(rateLimit);
  const quotaLow = !rateLimited && isQuotaLow(rateLimit);

  return (
    <Stack gap='xs'>
      <Group gap='xs'>
        <Text size='xs' c='dimmed'>
          {overview.checking ? (
            t('status.checking', {})
          ) : overview.checked_at ? (
            <>
              {t('status.lastChecked', {})} <FormattedTimestamp timestamp={overview.checked_at} />
            </>
          ) : (
            t('status.neverChecked', {})
          )}
        </Text>
        <Text size='xs' c='dimmed'>
          ·
        </Text>
        <Text size='xs' c='dimmed'>
          {t('status.panelVersion', { version: overview.panel_version })}
        </Text>
      </Group>

      {!management.available && (
        <Alert color='yellow' icon={<FontAwesomeIcon icon={faCircleInfo} />} title={t('management.notifyOnly', {})}>
          {management.reason === 'disabled' ? t('management.disabled', {}) : t('management.notHeavy', {})}
        </Alert>
      )}
      {management.available && !overview.can_manage && (
        <Alert color='blue' icon={<FontAwesomeIcon icon={faCircleInfo} />}>
          {t('management.noPermission', {})}
        </Alert>
      )}
      {rateLimited && rateLimit && resetTime && (
        <Alert
          color='orange'
          icon={<FontAwesomeIcon icon={faExclamationTriangle} />}
          title={t('errors.rateLimited', {})}
        >
          <Stack gap={2}>
            <span>{t('errors.rateLimitedContent', { time: resetTime.toLocaleString() })}</span>
            {!rateLimit.authenticated && <span>{t('errors.tokenHint', {})}</span>}
          </Stack>
        </Alert>
      )}
      {quotaLow && rateLimit && resetTime && (
        <Alert color='yellow' icon={<FontAwesomeIcon icon={faExclamationTriangle} />} title={t('errors.quotaLow', {})}>
          <Stack gap={2}>
            <span>
              {t('errors.quotaLowContent', {
                remaining: rateLimit.remaining,
                limit: rateLimit.limit,
                time: resetTime.toLocaleTimeString(),
              })}
            </span>
            {!rateLimit.authenticated && <span>{t('errors.tokenHint', {})}</span>}
          </Stack>
        </Alert>
      )}
      {overview.check_errors.length > 0 && (
        <Alert color='red' icon={<FontAwesomeIcon icon={faExclamationTriangle} />} title={t('errors.title', {})}>
          <Stack gap={2}>
            {overview.check_errors.map((error) => (
              <span key={error}>{error}</span>
            ))}
            {!rateLimited &&
              !quotaLow &&
              rateLimit?.authenticated === false &&
              overview.check_errors.some((error) => /rate.?limit/i.test(error)) && (
                <span>{t('errors.tokenHint', {})}</span>
              )}
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}
