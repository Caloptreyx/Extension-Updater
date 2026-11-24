import { faArrowsRotate, faExclamationTriangle, faHammer } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import Button from '@/elements/buttons/Button.tsx';
import Alert from '@/elements/feedback/Alert.tsx';
import { safeLocalStorageGet, safeLocalStorageSet } from '@/lib/safeStorage.ts';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { getSummary, PACKAGE, PAGE_PATH } from '../api.ts';
import { bannerDismissKey, failedAutoDismissKey } from '../lib/status.ts';
import { useExtTranslations } from '../translations.ts';

export const summaryKey = [PACKAGE, 'summary'] as const;

const SHOWN = 3;

/** Shown above admin pages while building, after a failed automatic update, or when updates are available. */
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
    refetchInterval: (query) => (query.state.data?.building ? 15_000 : 5 * 60_000),
    staleTime: 60_000,
  });
  // keys dismissed in this tab so alerts hide immediately without a storage read
  const [dismissedUpdates, setDismissedUpdates] = useState<string | null>(null);
  const [dismissedFailedAuto, setDismissedFailedAuto] = useState<string | null>(null);

  const data = summary.data;
  if (!canRead || onPage || !data) return null;

  // 1. Live build in progress takes priority over available-updates prompts
  if (data.building) {
    const itemsText =
      data.building_items.length > 0
        ? t('banner.buildingItems', { items: data.building_items.join(', ') })
        : t('banner.buildingGeneric', {});
    return (
      <div className='px-4 lg:px-6 mt-2 lg:mt-6'>
        <Alert color='blue' icon={<FontAwesomeIcon icon={faHammer} />} title={t('banner.buildingTitle', {})}>
          <div className='flex flex-col md:flex-row md:items-center gap-2 justify-between'>
            <span>{itemsText}</span>
            <Button size='xs' variant='light' onClick={() => navigate(PAGE_PATH)}>
              {t('actions.viewProgress', {})}
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  // 2. Failed automatic update alert (dismissible per run id)
  const failedAuto = data.last_failed_auto_run;
  if (failedAuto) {
    const failKey = failedAutoDismissKey(failedAuto.id);
    if (dismissedFailedAuto !== failKey && safeLocalStorageGet(failKey) === null) {
      const dismissFail = () => {
        safeLocalStorageSet(failKey, '1');
        setDismissedFailedAuto(failKey);
      };
      return (
        <div className='px-4 lg:px-6 mt-2 lg:mt-6'>
          <Alert
            color='red'
            icon={<FontAwesomeIcon icon={faExclamationTriangle} />}
            title={t('banner.failedAutoTitle', {})}
            withCloseButton
            onClose={dismissFail}
            closeButtonLabel={t('banner.dismiss', {})}
          >
            <div className='flex flex-col md:flex-row md:items-center gap-2 justify-between'>
              <span>{failedAuto.message || t('banner.failedAutoGeneric', {})}</span>
              <Button size='xs' variant='light' color='red' onClick={() => navigate(`${PAGE_PATH}?tab=history`)}>
                {t('actions.viewDetails', {})}
              </Button>
            </div>
          </Alert>
        </div>
      );
    }
  }

  // 3. Available updates banner (controlled by show_banner setting)
  if (!data.show_banner || data.updates.length === 0) return null;

  const key = bannerDismissKey(data.updates);
  if (dismissedUpdates === key || safeLocalStorageGet(key) !== null) return null;

  const names = data.updates.slice(0, SHOWN).map((update) => `${update.name} ${update.to}`);
  const list = names.join(', ');
  const text =
    data.updates.length > SHOWN
      ? t('banner.more', { list, count: data.updates.length - SHOWN })
      : t('banner.content', { list });

  const dismiss = () => {
    safeLocalStorageSet(key, '1');
    setDismissedUpdates(key);
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
