import { faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import Button from '@/elements/buttons/Button.tsx';
import TitleCard from '@/elements/data-display/TitleCard.tsx';
import StatusLine from '@/elements/feedback/StatusLine.tsx';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { getSummary, PAGE_PATH } from '../api.ts';
import { useExtTranslations } from '../translations.ts';
import { summaryKey } from './UpdatesBanner.tsx';

/** A card on the panel's admin Updates page. */
export default function UpdatesCard() {
  const { t } = useExtTranslations();
  const navigate = useNavigate();
  const canRead = useAdminCan('extensions.read');
  const summary = useQuery({ queryKey: summaryKey, queryFn: getSummary, enabled: canRead, staleTime: 60_000 });

  if (!canRead) return null;

  const count = summary.data?.updates.length ?? 0;

  return (
    <TitleCard title={t('card.title', {})} icon={<FontAwesomeIcon icon={faPuzzlePiece} />}>
      <div className='flex flex-col md:flex-row gap-2 justify-between md:items-center'>
        <StatusLine status={count > 0 ? 'warning' : 'ok'}>
          {count > 0 ? t('card.updates', { count }) : t('card.none', {})}
        </StatusLine>
        <Button size='xs' variant='light' onClick={() => navigate(PAGE_PATH)}>
          {t('card.open', {})}
        </Button>
      </div>
    </TitleCard>
  );
}
