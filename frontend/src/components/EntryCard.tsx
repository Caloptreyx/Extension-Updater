import { faGithub } from '@fortawesome/free-brands-svg-icons';
import {
  faArrowRight,
  faArrowRotateLeft,
  faArrowUpRightFromSquare,
  faChevronDown,
  faChevronRight,
  faDownload,
  faEllipsisVertical,
  faForwardStep,
  faPause,
  faPlay,
  faRotateLeft,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import classNames from 'classnames';
import { useState } from 'react';
import ActionIcon from '@/elements/buttons/ActionIcon.tsx';
import Button from '@/elements/buttons/Button.tsx';
import Badge from '@/elements/data-display/Badge.tsx';
import Card from '@/elements/data-display/Card.tsx';
import Checkbox from '@/elements/input/Checkbox.tsx';
import Collapse from '@/elements/layout/Collapse.tsx';
import Group from '@/elements/layout/Group.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import Menu from '@/elements/overlays/Menu.tsx';
import FormattedTimestamp from '@/elements/time/FormattedTimestamp.tsx';
import Anchor from '@/elements/typography/Anchor.tsx';
import Text from '@/elements/typography/Text.tsx';
import Title from '@/elements/typography/Title.tsx';
import type { Entry } from '../lib/types.ts';
import {
  canForceInstall,
  canInstall,
  entryBadges,
  heldBack,
  isLatestSkipped,
  offered as offeredRelease,
  type StatusBadge,
} from '../lib/status.ts';
import { useExtTranslations } from '../translations.ts';
import ReleaseNotes from './ReleaseNotes.tsx';

interface Props {
  entry: Entry;
  /** Install and rollback buttons are shown. */
  manageable: boolean;
  /** Pause/skip actions can be changed (extensions.manage; works without the heavy image too). */
  canToggle: boolean;
  /** A build runs or another request is pending. */
  locked: boolean;
  loading: boolean;
  /** A pause/skip request is pending for this entry. */
  busyAction: boolean;
  /** Batch selection state (only rendered when selectable & handler provided). */
  selected?: boolean;
  onToggleSelect?: (packageName: string, checked: boolean) => void;
  onInstall: (entry: Entry) => void;
  onForceInstall: (entry: Entry) => void;
  onRollback: (entry: Entry) => void;
  onToggleUpdates: (entry: Entry, enabled: boolean) => void;
  onSkipVersion: (entry: Entry, version: string | null) => void;
}

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

const openExternal = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

export default function EntryCard({
  entry,
  manageable,
  canToggle,
  locked,
  loading,
  busyAction,
  selected = false,
  onToggleSelect,
  onInstall,
  onForceInstall,
  onRollback,
  onToggleUpdates,
  onSkipVersion,
}: Props) {
  const { t } = useExtTranslations();
  const [notesOpen, setNotesOpen] = useState(false);
  const { latest, installed } = entry;
  const offered = offeredRelease(entry);
  const held = heldBack(entry);
  const skipped = isLatestSkipped(entry);
  const installable = canInstall(entry);
  const forceInstallable = canForceInstall(entry);
  const highlightUpdate = Boolean(installed && offered && offered.verified);

  const badgeLabel = ({ kind }: StatusBadge) => {
    switch (kind) {
      case 'needs_panel':
        return t('badge.needs_panel', { version: entry.needs_panel?.panel_version ?? '' });
      case 'up_to_date':
        return t('badge.up_to_date', {});
      case 'update_available':
        return t('badge.update_available', {});
      case 'installable':
        return t('badge.installable', {});
      case 'unverified':
        return t('badge.unverified', {});
      case 'license':
        return t('badge.license', {});
      case 'no_release':
        return t('badge.no_release', {});
      case 'unpublished':
        return t('badge.unpublished', {});
      case 'disabled':
        return t('badge.disabled', {});
      case 'archived':
        return t('badge.archived', {});
      case 'updates_off':
        return t('badge.updates_off', {});
      case 'skipped':
        return t('badge.skipped', { version: entry.skipped_version ?? '' });
    }
  };

  const canSkipCurrent = Boolean(
    canToggle && installed && entry.status === 'update_available' && latest && entry.updates_enabled && !skipped,
  );
  const canClearSkip = Boolean(canToggle && skipped && entry.skipped_version);
  const canShowPauseToggle = canToggle;
  const canShowForceInstall = manageable && forceInstallable && Boolean(held);
  const canShowRollback = Boolean(manageable && installed && entry.rollback);
  const hasManageMenuItems =
    canShowPauseToggle || canSkipCurrent || canClearSkip || canShowForceInstall || canShowRollback;
  const hasLinkMenuItems = Boolean(latest?.asset || latest || entry.repo_url);
  const hasMenu = hasManageMenuItems || hasLinkMenuItems;

  return (
    <Card
      p='sm'
      leftStripeClassName={highlightUpdate ? 'bg-blue-500' : undefined}
      className={classNames(highlightUpdate && 'bg-blue-500/4! border-blue-500/30!')}
    >
      <Stack gap='xs'>
        <div className='flex items-start gap-3 justify-between'>
          <div className='flex items-start gap-3 min-w-0 flex-1'>
            {manageable && installable && onToggleSelect && (
              <div className='pt-0.5 shrink-0'>
                <Checkbox
                  checked={selected}
                  disabled={locked}
                  aria-label={entry.name}
                  onChange={(event) => onToggleSelect(entry.package_name, event.currentTarget.checked)}
                />
              </div>
            )}

            <Stack gap={4} className='min-w-0 flex-1'>
              <Group gap='xs' wrap='wrap' align='center'>
                <Title order={5} fw={600}>
                  {entry.name}
                </Title>
                <Text size='xs' c='dimmed' className='font-mono'>
                  {entry.package_name}
                </Text>
                {entry.is_self && (
                  <Badge variant='outline' size='xs'>
                    {t('list.self', {})}
                  </Badge>
                )}
              </Group>

              {!installed && entry.description && (
                <Text size='sm' c='dimmed' className='line-clamp-2'>
                  {entry.description}
                </Text>
              )}

              <Group gap='xs' wrap='wrap' align='center'>
                {installed ? (
                  offered ? (
                    <Group gap={6} wrap='nowrap' align='center'>
                      <Text size='sm' className='font-mono tabular-nums'>
                        <span className='opacity-75'>{installed.version}</span>{' '}
                        <FontAwesomeIcon icon={faArrowRight} size='xs' className='mx-0.5 opacity-60' />{' '}
                        <b>{offered.version}</b>
                      </Text>
                      {offered.prerelease && (
                        <Badge size='xs' color='orange' variant='light'>
                          {t('list.prerelease', {})}
                        </Badge>
                      )}
                    </Group>
                  ) : (
                    <Text size='sm' className='font-mono tabular-nums' fw={500}>
                      v{installed.version}
                    </Text>
                  )
                ) : (
                  latest && (
                    <Group gap={6} wrap='nowrap' align='center'>
                      <Text size='sm' className='font-mono tabular-nums' fw={500}>
                        v{latest.version}
                      </Text>
                      {latest.prerelease && (
                        <Badge size='xs' color='orange' variant='light'>
                          {t('list.prerelease', {})}
                        </Badge>
                      )}
                    </Group>
                  )
                )}

                {latest?.published_at && (
                  <Text size='xs' c='dimmed'>
                    · <FormattedTimestamp timestamp={latest.published_at} />
                  </Text>
                )}

                {entryBadges(entry).map((badge) => (
                  <Badge key={badge.kind} color={badge.color} variant='light' size='xs'>
                    {badgeLabel(badge)}
                  </Badge>
                ))}

                {entry.notes.length > 0 && (
                  <Button
                    size='compact-xs'
                    variant='subtle'
                    leftSection={<FontAwesomeIcon icon={notesOpen ? faChevronDown : faChevronRight} size='xs' />}
                    onClick={() => setNotesOpen((open) => !open)}
                  >
                    {notesOpen ? t('list.hideNotes', {}) : t('list.notes', { count: entry.notes.length })}
                  </Button>
                )}
              </Group>

              {offered && !offered.verified && (
                <Text size='xs' c='orange'>
                  {t('list.unverifiedHint', { version: offered.version })}
                </Text>
              )}
              {held && !entry.updates_enabled && (
                <Text size='xs' c='dimmed'>
                  {t('list.pausedHint', { version: held.version })}
                </Text>
              )}
              {held && entry.updates_enabled && skipped && (
                <Text size='xs' c='dimmed'>
                  {t('list.skippedHint', { version: held.version })}
                </Text>
              )}
              {entry.needs_panel && (
                <Text size='xs' c='yellow'>
                  {t('list.needsPanelHint', {
                    version: entry.needs_panel.version,
                    range: entry.needs_panel.panel_version,
                  })}
                </Text>
              )}
            </Stack>
          </div>

          <Group gap='xs' wrap='nowrap' className='shrink-0'>
            {manageable && installable && (
              <Button size='xs' loading={loading} disabled={locked} onClick={() => onInstall(entry)}>
                {installed ? t('actions.update', {}) : t('actions.install', {})}
              </Button>
            )}

            {hasMenu && (
              <Menu position='bottom-end' withinPortal>
                <Menu.Target>
                  <ActionIcon
                    variant='subtle'
                    color='gray'
                    size='md'
                    loading={busyAction}
                    aria-label={t('actions.moreActions', {})}
                  >
                    <FontAwesomeIcon icon={faEllipsisVertical} />
                  </ActionIcon>
                </Menu.Target>

                <Menu.Dropdown>
                  {canShowPauseToggle && (
                    <Menu.Item
                      leftSection={<FontAwesomeIcon icon={entry.updates_enabled ? faPause : faPlay} size='xs' />}
                      disabled={busyAction}
                      onClick={() => onToggleUpdates(entry, !entry.updates_enabled)}
                    >
                      {entry.updates_enabled ? t('actions.pauseUpdates', {}) : t('actions.resumeUpdates', {})}
                    </Menu.Item>
                  )}

                  {canSkipCurrent && latest && (
                    <Menu.Item
                      leftSection={<FontAwesomeIcon icon={faForwardStep} size='xs' />}
                      disabled={busyAction}
                      onClick={() => onSkipVersion(entry, latest.version)}
                    >
                      {t('actions.skipVersion', { version: latest.version })}
                    </Menu.Item>
                  )}

                  {canClearSkip && entry.skipped_version && (
                    <Menu.Item
                      leftSection={<FontAwesomeIcon icon={faRotateLeft} size='xs' />}
                      disabled={busyAction}
                      onClick={() => onSkipVersion(entry, null)}
                    >
                      {t('actions.clearSkip', { version: entry.skipped_version })}
                    </Menu.Item>
                  )}

                  {canShowForceInstall && held && (
                    <Menu.Item
                      leftSection={<FontAwesomeIcon icon={faDownload} size='xs' />}
                      disabled={locked}
                      onClick={() => onForceInstall(entry)}
                    >
                      {t('actions.installAnyway', { version: held.version })}
                    </Menu.Item>
                  )}

                  {canShowRollback && entry.rollback && (
                    <Menu.Item
                      color='orange'
                      leftSection={<FontAwesomeIcon icon={faArrowRotateLeft} size='xs' />}
                      disabled={locked}
                      onClick={() => onRollback(entry)}
                    >
                      {t('actions.rollback', { version: entry.rollback.version })}
                    </Menu.Item>
                  )}

                  {hasManageMenuItems && hasLinkMenuItems && <Menu.Divider />}

                  {latest?.asset && (
                    <Menu.Item
                      leftSection={<FontAwesomeIcon icon={faDownload} size='xs' />}
                      onClick={() => openExternal(latest.asset!.download_url)}
                    >
                      {t('actions.download', { version: latest.version })}
                    </Menu.Item>
                  )}

                  {latest && (
                    <Menu.Item
                      leftSection={<FontAwesomeIcon icon={faArrowUpRightFromSquare} size='xs' />}
                      onClick={() => openExternal(latest.html_url)}
                    >
                      {t('actions.release', {})}
                    </Menu.Item>
                  )}

                  {entry.repo_url && (
                    <Menu.Item
                      leftSection={<FontAwesomeIcon icon={faGithub} size='xs' />}
                      onClick={() => openExternal(entry.repo_url!)}
                    >
                      {t('actions.github', {})}
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        </div>

        {entry.notes.length > 0 && (
          <Collapse expanded={notesOpen}>
            <Stack gap='md' pt='xs' className='border-t border-(--mantine-color-default-border)'>
              {entry.notes.map((release) => (
                <Stack key={release.tag} gap={4}>
                  <Group gap='xs'>
                    <Anchor fw={600} size='sm' href={release.html_url} {...external}>
                      {release.name || release.tag}
                    </Anchor>
                    {release.prerelease && (
                      <Badge size='xs' color='orange' variant='light'>
                        {t('list.prerelease', {})}
                      </Badge>
                    )}
                    {release.published_at && (
                      <Text size='xs' c='dimmed'>
                        <FormattedTimestamp timestamp={release.published_at} />
                      </Text>
                    )}
                  </Group>
                  {release.body.trim() ? (
                    <ReleaseNotes body={release.body} />
                  ) : (
                    <Text size='sm' c='dimmed'>
                      {t('list.noNotes', {})}
                    </Text>
                  )}
                </Stack>
              ))}
            </Stack>
          </Collapse>
        )}
      </Stack>
    </Card>
  );
}
