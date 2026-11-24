import {
  faCheck,
  faClock,
  faExclamationTriangle,
  faHammer,
  faQuestion,
  faRotateRight,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import classNames from 'classnames';
import { useEffect, useState } from 'react';
import Button from '@/elements/buttons/Button.tsx';
import Badge from '@/elements/data-display/Badge.tsx';
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
import { BUILD_STEPS, buildStepIndex, formatElapsed, type BuildStep } from '../lib/status.ts';
import { useExtTranslations } from '../translations.ts';

function computeElapsed(startedAt: string | null): number | null {
  if (!startedAt) return null;
  const ms = Date.parse(startedAt);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

/** The running build: multi-step phase indicator, live elapsed timer, what it installs, its log. */
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
  const startedAt = supervisor?.started_at ?? run?.created ?? null;
  const [elapsed, setElapsed] = useState<number | null>(() => computeElapsed(startedAt));

  useEffect(() => {
    setElapsed(computeElapsed(startedAt));
    if (!startedAt) return;
    const id = window.setInterval(() => {
      setElapsed(computeElapsed(startedAt));
    }, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  // a succeeded build installs and restarts the panel; the run finishes once the new panel answers
  const phase =
    restarting || supervisor?.state.type === 'succeeded'
      ? tExt('status.restarting', {})
      : ((supervisor && getBuildPhase(t, supervisor.state)) ?? tExt('build.running', {}));

  const activeStep = buildStepIndex(supervisor, restarting);

  const stepLabel = (step: BuildStep) => {
    switch (step) {
      case 'preparing':
        return tExt('build.steps.preparing', {});
      case 'adding':
        return tExt('build.steps.adding', {});
      case 'compiling':
        return tExt('build.steps.compiling', {});
      case 'verifying':
        return tExt('build.steps.verifying', {});
      case 'installing':
        return tExt('build.steps.installing', {});
      case 'restarting':
        return tExt('build.steps.restarting', {});
    }
  };

  return (
    <TitleCard
      title={tExt('build.title', {})}
      icon={<FontAwesomeIcon icon={faHammer} />}
      rightSection={
        <Group gap='xs' className='ml-auto'>
          {elapsed !== null && (
            <Badge
              variant='light'
              color='gray'
              size='sm'
              leftSection={<FontAwesomeIcon icon={faClock} size='xs' />}
              className='tabular-nums'
            >
              {tExt('build.elapsed', { time: formatElapsed(elapsed) })}
            </Badge>
          )}
          {onViewLog && (
            <Button size='xs' variant='light' onClick={onViewLog}>
              {tExt('actions.viewLog', {})}
            </Button>
          )}
        </Group>
      }
    >
      <Stack gap='sm'>
        <div className='grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2'>
          {BUILD_STEPS.map((step, index) => {
            const done = index < activeStep;
            const current = index === activeStep;
            return (
              <div
                key={step}
                className={classNames(
                  'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                  done && 'border-green-500/40 bg-green-500/10 text-green-400 light:text-green-700',
                  current && 'border-blue-500/60 bg-blue-500/10 font-semibold',
                  !done && !current && 'border-(--mantine-color-default-border) opacity-55',
                )}
              >
                <span className='flex h-4 w-4 shrink-0 items-center justify-center'>
                  {done ? (
                    <FontAwesomeIcon icon={faCheck} size='xs' />
                  ) : current ? (
                    <Spinner size={12} />
                  ) : (
                    <span className='h-1.5 w-1.5 rounded-full bg-current opacity-60' />
                  )}
                </span>
                <span className='truncate'>{stepLabel(step)}</span>
              </div>
            );
          })}
        </div>

        <Group gap='sm' wrap='nowrap'>
          <Spinner size={16} />
          <Text size='sm' fw={500}>
            {phase}
          </Text>
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

/** The outcome of the newest finished run (dismissible via localStorage). */
export function RunResult({
  run,
  onViewLog,
  onRetry,
  onDismiss,
  retrying,
  locked,
}: {
  run: Run;
  onViewLog: (() => void) | null;
  onRetry: (() => void) | null;
  onDismiss?: () => void;
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

  const dismissProps = onDismiss
    ? {
        withCloseButton: true,
        onClose: onDismiss,
        closeButtonLabel: tExt('actions.dismiss', {}),
      }
    : {};

  if (run.state === 'succeeded') {
    return (
      <Alert
        color='green'
        icon={<FontAwesomeIcon icon={faCheck} />}
        title={rollback ? tExt('run.succeededRollback', {}) : tExt('run.succeeded', {})}
        {...dismissProps}
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
        {...dismissProps}
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
    <Alert color='gray' icon={<FontAwesomeIcon icon={faQuestion} />} title={tExt('run.unknown', {})} {...dismissProps}>
      <Stack gap={2}>
        <span>{tExt('run.unknownContent', {})}</span>
        {footer}
      </Stack>
    </Alert>
  );
}
