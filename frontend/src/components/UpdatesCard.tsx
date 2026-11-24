import { faExclamationTriangle, faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import Button from '@/elements/buttons/Button.tsx';
import ThemeIcon from '@/elements/data-display/ThemeIcon.tsx';
import TitleCard from '@/elements/data-display/TitleCard.tsx';
import Spinner from '@/elements/feedback/Spinner.tsx';
import StatusLine from '@/elements/feedback/StatusLine.tsx';
import Group from '@/elements/layout/Group.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import Text from '@/elements/typography/Text.tsx';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { getSummary, PAGE_PATH } from '../api.ts';
import { useExtTranslations } from '../translations.ts';
import { summaryKey } from './UpdatesBanner.tsx';

const SHOWN = 4;

/** A card on the panel's admin Updates page. */
export default function UpdatesCard() {
  const { t } = useExtTranslations();
  const navigate = useNavigate();
  const canRead = useAdminCan('extensions.read');
  const summary = useQuery({
    queryKey: summaryKey,
    queryFn: getSummary,
    enabled: canRead,
    refetchInterval: (query) => (query.state.data?.building ? 15_000 : false),
    staleTime: 60_000,
  });

  if (!canRead) return null;

  const data = summary.data;
  const updates = data?.updates ?? [];
  const count = updates.length;
  const building = data?.building ?? false;
  const buildingItems = data?.building_items ?? [];
  const failedAuto = data?.last_failed_auto_run ?? null;

  const updatePreview =
    count > 0
      ? updates
          .slice(0, SHOWN)
          .map((u) => `${u.name} ${u.to}`)
          .join(', ') + (count > SHOWN ? ` (+${count - SHOWN})` : '')
      : null;

  return (
    <TitleCard title={t('card.title', {})} icon={<FontAwesomeIcon icon={faPuzzlePiece} />}>
      <div className='flex flex-col md:flex-row gap-3 justify-between md:items-center'>
        {building ? (
          <Group gap='xs' wrap='nowrap' align='center'>
            <Spinner size={16} />
            <Text size='sm'>
              {buildingItems.length > 0
                ? t('card.buildingWithItems', { items: buildingItems.join(', ') })
                : t('card.building', {})}
            </Text>
          </Group>
        ) : failedAuto ? (
          <Stack gap={2}>
            <Group gap='xs' wrap='nowrap' align='center'>
              <ThemeIcon size='sm' radius='xl' variant='light' color='red'>
                <FontAwesomeIcon icon={faExclamationTriangle} size='xs' />
              </ThemeIcon>
              <Text size='sm' fw={500}>
                {t('card.failedAuto', {})}
              </Text>
            </Group>
            {failedAuto.message && (
              <Text size='xs' c='dimmed' className='line-clamp-2 pl-7'>
                {failedAuto.message}
              </Text>
            )}
          </Stack>
        ) : (
          <Stack gap={2}>
            <StatusLine status={count > 0 ? 'warning' : 'ok'}>
              {count > 0 ? t('card.updates', { count }) : t('card.none', {})}
            </StatusLine>
            {updatePreview && (
              <Text size='xs' c='dimmed' className='pl-7'>
                {updatePreview}
              </Text>
            )}
          </Stack>
        )}

        <Button
          size='xs'
          variant='light'
          color={failedAuto && !building ? 'red' : undefined}
          onClick={() => navigate(failedAuto && !building ? `${PAGE_PATH}?tab=history` : PAGE_PATH)}
        >
          {building ? t('actions.viewProgress', {}) : failedAuto ? t('actions.viewDetails', {}) : t('card.open', {})}
        </Button>
      </div>
    </TitleCard>
  );
}
