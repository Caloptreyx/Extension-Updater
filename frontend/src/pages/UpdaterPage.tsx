import {
  faArrowsRotate,
  faCircleInfo,
  faExclamationTriangle,
  faGear,
  faPuzzlePiece,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/buttons/Button.tsx';
import AdminContentContainer from '@/elements/containers/AdminContentContainer.tsx';
import TitleCard from '@/elements/data-display/TitleCard.tsx';
import Alert from '@/elements/feedback/Alert.tsx';
import Spinner from '@/elements/feedback/Spinner.tsx';
import Group from '@/elements/layout/Group.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import ConfirmationModal from '@/elements/modals/ConfirmationModal.tsx';
import FormattedTimestamp from '@/elements/time/FormattedTimestamp.tsx';
import Text from '@/elements/typography/Text.tsx';
import BuildLogsModal from '@/pages/admin/extensions/modals/BuildLogsModal.tsx';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import type { Entry, LicenseNeeded, Overview, UpdateRequest } from '../lib/types.ts';
import { checkNow, getOverview, PACKAGE, rollback, setUpdates, startUpdate } from '../api.ts';
import EntryCard from '../components/EntryCard.tsx';
import LicenseModal from '../components/LicenseModal.tsx';
import { BuildCard, RunResult } from '../components/RunStatus.tsx';
import SettingsForm from '../components/SettingsForm.tsx';
import { summaryKey } from '../components/UpdatesBanner.tsx';
import {
  activeBuildId,
  installableEntries,
  isBuilding,
  lastFinishedRun,
  packagesOf,
  retryPackages,
  updatableEntries,
} from '../lib/status.ts';
import { useExtTranslations } from '../translations.ts';

const overviewKey = [PACKAGE, 'overview'] as const;

const POLL_BUILDING_MS = 4000;
const POLL_IDLE_MS = 60_000;

export default function UpdaterPage() {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const canRead = useAdminCan('extensions.read');
  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: getOverview,
    enabled: canRead,
    // the panel restarts after a successful build; failed requests keep the last overview and polling goes on
    refetchInterval: (query) => (query.state.data && isBuilding(query.state.data) ? POLL_BUILDING_MS : POLL_IDLE_MS),
  });
  const [checking, setChecking] = useState(false);
  /** The button whose request is pending: a package name, 'all' or 'retry'. */
  const [pending, setPending] = useState<string | null>(null);
  /** The package whose Updates switch request is pending. */
  const [toggling, setToggling] = useState<string | null>(null);
  const [licenses, setLicenses] = useState<{ needed: LicenseNeeded[]; request: UpdateRequest } | null>(null);
  const [rollbackEntry, setRollbackEntry] = useState<Entry | null>(null);
  const [log, setLog] = useState<{ opened: boolean; buildId: number | null }>({ opened: false, buildId: null });

  const data = overview.data;
  const building = data ? isBuilding(data) : false;

  // the banner and the Updates card count updates; refresh them once a build is over
  const wasBuilding = useRef(building);
  useEffect(() => {
    if (wasBuilding.current && !building) queryClient.invalidateQueries({ queryKey: summaryKey });
    wasBuilding.current = building;
  }, [building, queryClient]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: [PACKAGE] });

  const sendUpdate = async (request: UpdateRequest) => {
    const result = await startUpdate(request);
    if (result.type === 'needs_license') {
      setLicenses({ needed: result.licenses, request });
      return;
    }
    setLicenses(null);
    addToast(t('actions.started', {}), 'success');
    await refresh();
  };

  const run = (key: string, request: UpdateRequest) => {
    setPending(key);
    sendUpdate(request)
      .catch((error) => addToast(httpErrorToHuman(error), 'error'))
      .finally(() => setPending(null));
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
    setToggling(entry.package_name);
    setUpdates(entry.package_name, enabled)
      .then(async () => {
        addToast(t(enabled ? 'actions.updatesTurnedOn' : 'actions.updatesTurnedOff', { name: entry.name }), 'success');
        await refresh();
      })
      .catch((error) => addToast(httpErrorToHuman(error), 'error'))
      .finally(() => setToggling(null));
  };

  const manageable = !!data && data.management.available && data.can_manage;
  const locked = building || pending !== null;
  const updatable = data ? updatableEntries(data.extensions) : [];
  const finished = data && !building ? lastFinishedRun(data.runs) : null;

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
        <Button
          loading={pending === 'all'}
          disabled={locked}
          onClick={() => run('all', { packages: packagesOf(updatable), accept_licenses: [], force: false })}
        >
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
        <Stack>
          <Notices overview={data} />

          {building && (
            <BuildCard
              run={data.runs.find((r) => r.state === 'building') ?? null}
              supervisor={data.supervisor}
              restarting={overview.isError}
              onViewLog={data.can_manage ? () => openLog(activeBuildId(data)) : null}
            />
          )}

          {finished && (
            <RunResult
              run={finished}
              onViewLog={data.can_manage && finished.build_id !== null ? () => openLog(finished.build_id) : null}
              onRetry={
                manageable && finished.state === 'failed' && finished.kind === 'update'
                  ? () => run('retry', { packages: retryPackages(finished), accept_licenses: [], force: true })
                  : null
              }
              retrying={pending === 'retry'}
              locked={locked}
            />
          )}

          <TitleCard title={t('list.installed', {})} icon={<FontAwesomeIcon icon={faPuzzlePiece} />}>
            <EntryList
              entries={data.extensions.filter((entry) => entry.installed)}
              empty={t('list.none', {})}
              manageable={manageable}
              canToggle={data.can_manage}
              locked={locked}
              pending={pending}
              toggling={toggling}
              onInstall={(entry) => run(entry.package_name, packageRequest(entry))}
              onRollback={setRollbackEntry}
              onToggleUpdates={toggleUpdates}
            />
          </TitleCard>

          <TitleCard title={t('list.notInstalled', {})} icon={<FontAwesomeIcon icon={faCircleInfo} />}>
            <EntryList
              entries={installableEntries(data.extensions)}
              empty={t('list.noneAvailable', {})}
              manageable={manageable}
              canToggle={data.can_manage}
              locked={locked}
              pending={pending}
              toggling={toggling}
              onInstall={(entry) => run(entry.package_name, packageRequest(entry))}
              onRollback={setRollbackEntry}
              onToggleUpdates={toggleUpdates}
            />
          </TitleCard>

          <TitleCard title={t('settings.title', {})} icon={<FontAwesomeIcon icon={faGear} />}>
            <SettingsForm />
          </TitleCard>
        </Stack>
      )}

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

const packageRequest = (entry: Entry): UpdateRequest => ({
  packages: packagesOf([entry]),
  accept_licenses: [],
  force: false,
});

function EntryList({
  entries,
  empty,
  pending,
  toggling,
  ...props
}: {
  entries: Entry[];
  empty: string;
  manageable: boolean;
  canToggle: boolean;
  locked: boolean;
  pending: string | null;
  toggling: string | null;
  onInstall: (entry: Entry) => void;
  onRollback: (entry: Entry) => void;
  onToggleUpdates: (entry: Entry, enabled: boolean) => void;
}) {
  if (entries.length === 0) {
    return (
      <Text size='sm' c='dimmed'>
        {empty}
      </Text>
    );
  }
  return (
    <Stack gap='sm'>
      {entries.map((entry) => (
        <EntryCard
          key={entry.package_name}
          entry={entry}
          loading={pending === entry.package_name}
          toggling={toggling === entry.package_name}
          {...props}
        />
      ))}
    </Stack>
  );
}

/** Why installing is off, check problems, the rate limit and when GitHub was last checked. */
function Notices({ overview }: { overview: Overview }) {
  const { t } = useExtTranslations();
  const { management, rate_limit: rateLimit } = overview;
  const resetTime = rateLimit ? new Date(rateLimit.reset * 1000) : null;
  const rateLimited = !!rateLimit && !!resetTime && rateLimit.remaining === 0 && resetTime.getTime() > Date.now();

  return (
    <>
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
      {rateLimited && (
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
      {overview.check_errors.length > 0 && (
        <Alert color='red' icon={<FontAwesomeIcon icon={faExclamationTriangle} />} title={t('errors.title', {})}>
          <Stack gap={2}>
            {overview.check_errors.map((error) => (
              <span key={error}>{error}</span>
            ))}
            {!rateLimited &&
              rateLimit?.authenticated === false &&
              overview.check_errors.some((error) => /rate.?limit/i.test(error)) && (
                <span>{t('errors.tokenHint', {})}</span>
              )}
          </Stack>
        </Alert>
      )}
      <Group gap='lg'>
        <Text size='sm' c='dimmed'>
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
        <Text size='sm' c='dimmed'>
          {t('status.panelVersion', { version: overview.panel_version })}
        </Text>
        {rateLimit && resetTime && (
          <Text size='sm' c='dimmed'>
            {t('status.rateLimit', {
              remaining: rateLimit.remaining,
              limit: rateLimit.limit,
              time: resetTime.toLocaleTimeString(),
            })}
          </Text>
        )}
      </Group>
    </>
  );
}
