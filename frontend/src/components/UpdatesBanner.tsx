import { faArrowsRotate } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import Button from '@/elements/buttons/Button.tsx';
import Alert from '@/elements/feedback/Alert.tsx';
import { safeLocalStorageGet, safeLocalStorageSet } from '@/lib/safeStorage.ts';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { getSummary, PACKAGE, PAGE_PATH } from '../api.ts';
import { bannerDismissKey } from '../lib/status.ts';
import { useExtTranslations } from '../translations.ts';

export const summaryKey = [PACKAGE, 'summary'] as const;

const SHOWN = 3;

/** Shown above every admin page while updates are available, until dismissed for that set of versions. */
export default function UpdatesBanner() {
  const { t } = useExtTranslations();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const canRead = useAdminCan('extensions.read');
  const onPage = pathname.startsWith(PAGE_PATH);
  const summary = useQuery({
    queryKey: summaryKey,
    queryFn: getSummary,
    enabled: canRead,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
  // the key of a dismissal made in this tab, so the banner hides without a storage read
  const [dismissed, setDismissed] = useState<string | null>(null);

  const data = summary.data;
  if (!canRead || onPage || !data?.show_banner || data.updates.length === 0) return null;

  const key = bannerDismissKey(data.updates);
  if (dismissed === key || safeLocalStorageGet(key) !== null) return null;

  const names = data.updates.slice(0, SHOWN).map((update) => `${update.name} ${update.to}`);
  const list = names.join(', ');
  const text =
    data.updates.length > SHOWN
      ? t('banner.more', { list, count: data.updates.length - SHOWN })
      : t('banner.content', { list });

  const dismiss = () => {
    safeLocalStorageSet(key, '1');
    setDismissed(key);
  };

  return (
    <div className='px-4 lg:px-6 mt-2 lg:mt-6'>
      <Alert
        color='blue'
        icon={<FontAwesomeIcon icon={faArrowsRotate} />}
        title={t('banner.title', {})}
        withCloseButton
        onClose={dismiss}
        closeButtonLabel={t('banner.dismiss', {})}
      >
        <div className='flex flex-col md:flex-row md:items-center gap-2 justify-between'>
          <span>{text}</span>
          <Button size='xs' variant='light' onClick={() => navigate(PAGE_PATH)}>
            {t('banner.open', {})}
          </Button>
        </div>
      </Alert>
    </div>
  );
}
