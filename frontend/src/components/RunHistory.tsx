import {
  faArrowRight,
  faCheck,
  faExclamationTriangle,
  faHammer,
  faQuestion,
  faRotateRight,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import Button from '@/elements/buttons/Button.tsx';
import Badge from '@/elements/data-display/Badge.tsx';
import Card from '@/elements/data-display/Card.tsx';
import Group from '@/elements/layout/Group.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import FormattedTimestamp from '@/elements/time/FormattedTimestamp.tsx';
import Code from '@/elements/typography/Code.tsx';
import Text from '@/elements/typography/Text.tsx';
import type { Run, RunState } from '../lib/types.ts';
import { useExtTranslations } from '../translations.ts';

interface Props {
  runs: Run[];
  canManage: boolean;
  manageable: boolean;
  locked: boolean;
  pending: string | null;
  onViewLog: (buildId: number | null) => void;
  onRetry: (run: Run) => void;
}

const STATE_COLOR: Record<RunState, string> = {
  building: 'blue',
  succeeded: 'green',
  failed: 'red',
  unknown: 'gray',
};

const STATE_STRIPE: Record<RunState, string> = {
  building: 'bg-blue-500',
  succeeded: 'bg-green-500',
  failed: 'bg-red-500',
  unknown: 'bg-gray-500',
};

const STATE_ICON: Record<RunState, typeof faCheck> = {
  building: faHammer,
  succeeded: faCheck,
  failed: faExclamationTriangle,
  unknown: faQuestion,
};

export default function RunHistory({ runs, canManage, manageable, locked, pending, onViewLog, onRetry }: Props) {
  const { t } = useExtTranslations();

  if (runs.length === 0) {
    return (
      <Card>
        <Text size='sm' c='dimmed'>
          {t('run.historyEmpty', {})}
        </Text>
      </Card>
    );
  }

  const stateLabel = (state: RunState) => {
    switch (state) {
      case 'building':
        return t('run.stateBuilding', {});
      case 'succeeded':
        return t('run.stateSucceeded', {});
      case 'failed':
        return t('run.stateFailed', {});
      case 'unknown':
        return t('run.stateUnknown', {});
    }
  };

  return (
    <Stack gap='sm'>
      {runs.map((run) => {
        const showLog = canManage && run.build_id !== null;
        const showRetry = manageable && run.state === 'failed' && run.kind === 'update';
        const retryKey = `retry:${run.id}`;

        return (
          <Card key={run.id} p='sm' leftStripeClassName={STATE_STRIPE[run.state]}>
            <Stack gap='xs'>
              <div className='flex flex-col sm:flex-row sm:items-center justify-between gap-2'>
                <Group gap='xs'>
                  <Badge
                    color={STATE_COLOR[run.state]}
                    variant='light'
                    size='sm'
                    leftSection={<FontAwesomeIcon icon={STATE_ICON[run.state]} size='xs' />}
                  >
                    {stateLabel(run.state)}
                  </Badge>
                  <Badge color='gray' variant='light' size='sm'>
                    {run.kind === 'rollback' ? t('run.kindRollback', {}) : t('run.kindUpdate', {})}
                  </Badge>
                  <Badge color={run.automatic ? 'violet' : 'gray'} variant='outline' size='sm'>
                    {run.automatic ? t('run.automatic', {}) : t('run.manual', {})}
                  </Badge>
                </Group>

                <Text size='xs' c='dimmed'>
                  <FormattedTimestamp timestamp={run.finished ?? run.created} />
                </Text>
              </div>

              {run.items.length > 0 && (
                <Group gap='xs' wrap='wrap'>
                  {run.items.map((item) => (
                    <Badge
                      key={`${run.id}:${item.package_name}`}
                      variant='default'
                      size='sm'
                      className='font-normal! normal-case!'
                    >
                      <span>{item.name}</span>{' '}
                      {item.from ? (
                        <span className='font-mono'>
                          {item.from} <FontAwesomeIcon icon={faArrowRight} size='xs' className='opacity-60' /> {item.to}
                        </span>
                      ) : (
                        <span className='font-mono'>
                          v{item.to} ({t('run.newInstall', {})})
                        </span>
                      )}
                    </Badge>
                  ))}
                </Group>
              )}

              {run.state === 'failed' && (
                <Stack gap='xs'>
                  {run.message && <Code block>{run.message}</Code>}
                  {run.failed_extensions.length > 0 && (
                    <Text size='xs' c='red'>
                      {t('run.failedExtensions', { extensions: run.failed_extensions.join(', ') })}
                    </Text>
                  )}
                </Stack>
              )}

              {(showLog || showRetry) && (
                <Group gap='xs' justify='flex-end'>
                  {showLog && (
                    <Button size='xs' variant='default' onClick={() => onViewLog(run.build_id)}>
                      {t('actions.viewLog', {})}
                    </Button>
                  )}
                  {showRetry && (
                    <Button
                      size='xs'
                      color='red'
                      variant='light'
                      leftSection={<FontAwesomeIcon icon={faRotateRight} />}
                      loading={pending === retryKey}
                      disabled={locked}
                      onClick={() => onRetry(run)}
                    >
                      {t('actions.retry', {})}
                    </Button>
                  )}
                </Group>
              )}
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}
