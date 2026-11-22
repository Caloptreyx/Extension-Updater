import { faCheck, faExclamationTriangle, faHammer, faQuestion, faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import Button from '@/elements/buttons/Button.tsx';
import TitleCard from '@/elements/data-display/TitleCard.tsx';
import Alert from '@/elements/feedback/Alert.tsx';
import Spinner from '@/elements/feedback/Spinner.tsx';
import Group from '@/elements/layout/Group.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import FormattedTimestamp from '@/elements/time/FormattedTimestamp.tsx';
import Code from '@/elements/typography/Code.tsx';
import Text from '@/elements/typography/Text.tsx';
import { getBuildPhase } from '@/lib/extensions.ts';
import { useTranslations } from '@/providers/TranslationProvider.tsx';
import type { Run, RunItem, SupervisorStatus } from '../lib/types.ts';
import { useExtTranslations } from '../translations.ts';

/** The running build: phase, what it installs, its log. */
export function BuildCard({
  run,
  supervisor,
  restarting,
  onViewLog,
}: {
  run: Run | null;
  supervisor: SupervisorStatus | null;
  /** The overview stopped answering while a build ran: the panel restarts. */
  restarting: boolean;
  onViewLog: (() => void) | null;
}) {
  const { t } = useTranslations();
  const { t: tExt } = useExtTranslations();
  // a succeeded build installs and restarts the panel; the run finishes once the new panel answers
  const phase =
    restarting || supervisor?.state.type === 'succeeded'
      ? tExt('status.restarting', {})
      : ((supervisor && getBuildPhase(t, supervisor.state)) ?? tExt('build.running', {}));

  return (
    <TitleCard
      title={tExt('build.title', {})}
      icon={<FontAwesomeIcon icon={faHammer} />}
      rightSection={
        onViewLog && (
          <Button size='xs' variant='light' onClick={onViewLog}>
            {tExt('actions.viewLog', {})}
          </Button>
        )
      }
    >
      <Stack gap='xs'>
        <Group gap='sm' wrap='nowrap'>
          <Spinner size={16} />
          <Text size='sm'>{phase}</Text>
        </Group>
        {run && run.items.length > 0 && (
          <Text size='sm'>
            {tExt('build.items', {
              items: run.items
                .map((item) => (item.from ? `${item.name} ${item.from} → ${item.to}` : `${item.name} ${item.to}`))
                .join(', '),
            })}
          </Text>
        )}
        <Text size='xs' c='dimmed'>
          {tExt('build.hint', {})}
        </Text>
      </Stack>
    </TitleCard>
  );
}

/** The outcome of the newest finished run. */
export function RunResult({
  run,
  onViewLog,
  onRetry,
  retrying,
  locked,
}: {
  run: Run;
  onViewLog: (() => void) | null;
  onRetry: (() => void) | null;
  retrying: boolean;
  locked: boolean;
}) {
  const { t: tExt } = useExtTranslations();
  const rollback = run.kind === 'rollback';

  const itemText = (item: RunItem) =>
    rollback
      ? tExt('run.rolledBack', { name: item.name, version: item.to })
      : item.from === null
        ? tExt('run.installed', { name: item.name, version: item.to })
        : tExt('run.updated', { name: item.name, version: item.to });

  const footer = (
    <Group gap='xs' mt={4}>
      {run.automatic && (
        <Text size='xs' c='dimmed'>
          {tExt('run.automatic', {})} ·
        </Text>
      )}
      <Text size='xs' c='dimmed'>
        <FormattedTimestamp timestamp={run.finished ?? run.created} />
      </Text>
    </Group>
  );

  if (run.state === 'succeeded') {
    return (
      <Alert
        color='green'
        icon={<FontAwesomeIcon icon={faCheck} />}
        title={rollback ? tExt('run.succeededRollback', {}) : tExt('run.succeeded', {})}
      >
        <Stack gap={2}>
          {run.items.map((item) => (
            <span key={item.package_name}>{itemText(item)}</span>
          ))}
          {footer}
        </Stack>
      </Alert>
    );
  }

  if (run.state === 'failed') {
    return (
      <Alert
        color='red'
        icon={<FontAwesomeIcon icon={faExclamationTriangle} />}
        title={rollback ? tExt('run.failedRollback', {}) : tExt('run.failed', {})}
      >
        <Stack gap='xs' align='flex-start'>
          {run.message && <Code block>{run.message}</Code>}
          {run.failed_extensions.length > 0 && (
            <span>{tExt('run.failedExtensions', { extensions: run.failed_extensions.join(', ') })}</span>
          )}
          <span>{tExt('run.restored', {})}</span>
          {(onViewLog || onRetry) && (
            <Group gap='xs'>
              {onViewLog && (
                <Button size='xs' variant='light' color='red' onClick={onViewLog}>
                  {tExt('actions.viewLog', {})}
                </Button>
              )}
              {onRetry && (
                <Button
                  size='xs'
                  color='red'
                  leftSection={<FontAwesomeIcon icon={faRotateRight} />}
                  loading={retrying}
                  disabled={locked}
                  onClick={onRetry}
                >
                  {tExt('actions.retry', {})}
                </Button>
              )}
            </Group>
          )}
          {footer}
        </Stack>
      </Alert>
    );
  }

  return (
    <Alert color='gray' icon={<FontAwesomeIcon icon={faQuestion} />} title={tExt('run.unknown', {})}>
      <Stack gap={2}>
        <span>{tExt('run.unknownContent', {})}</span>
        {footer}
      </Stack>
    </Alert>
  );
}
