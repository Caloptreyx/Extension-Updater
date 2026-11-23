import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { faArrowRotateLeft, faArrowUpRightFromSquare, faDownload } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useState } from 'react';
import Button from '@/elements/buttons/Button.tsx';
import Badge from '@/elements/data-display/Badge.tsx';
import Card from '@/elements/data-display/Card.tsx';
import Switch from '@/elements/input/Switch.tsx';
import Collapse from '@/elements/layout/Collapse.tsx';
import Group from '@/elements/layout/Group.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import FormattedTimestamp from '@/elements/time/FormattedTimestamp.tsx';
import Anchor from '@/elements/typography/Anchor.tsx';
import Text from '@/elements/typography/Text.tsx';
import Title from '@/elements/typography/Title.tsx';
import type { Entry } from '../lib/types.ts';
import { canInstall, entryBadges, heldBack, offered as offeredRelease, type StatusBadge } from '../lib/status.ts';
import { useExtTranslations } from '../translations.ts';
import ReleaseNotes from './ReleaseNotes.tsx';

interface Props {
  entry: Entry;
  /** Install and rollback buttons are shown. */
  manageable: boolean;
  /** The Updates switch can be changed (extensions.manage; works without the heavy image too). */
  canToggle: boolean;
  /** A build runs or another request is pending. */
  locked: boolean;
  loading: boolean;
  /** The Updates switch's request is pending. */
  toggling: boolean;
  onInstall: (entry: Entry) => void;
  onRollback: (entry: Entry) => void;
  onToggleUpdates: (entry: Entry, enabled: boolean) => void;
}

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

export default function EntryCard({
  entry,
  manageable,
  canToggle,
  locked,
  loading,
  toggling,
  onInstall,
  onRollback,
  onToggleUpdates,
}: Props) {
  const { t } = useExtTranslations();
  const [notesOpen, setNotesOpen] = useState(false);
  const { latest, installed } = entry;
  const offered = offeredRelease(entry);
  const held = heldBack(entry);

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
    }
  };

  return (
    <Card>
      <Stack gap='sm'>
        <div className='flex flex-col lg:flex-row lg:items-start gap-3 justify-between'>
          <Stack gap={4} className='min-w-0'>
            <Group gap='xs'>
              <Title order={4}>{entry.name}</Title>
              {entry.is_self && (
                <Badge variant='outline' size='sm'>
                  {t('list.self', {})}
                </Badge>
              )}
            </Group>
            <Text size='xs' c='dimmed'>
              {entry.package_name}
            </Text>
            <Group gap='lg'>
              {installed && (
                <Text size='sm'>
                  {t('list.version', {})}: <b>{installed.version}</b>
                </Text>
              )}
              <Text size='sm'>
                {t('list.latest', {})}: <b>{latest?.version ?? '-'}</b>
                {latest?.prerelease && (
                  <Badge ml='xs' size='xs' color='orange' variant='light'>
                    {t('list.prerelease', {})}
                  </Badge>
                )}
              </Text>
              {latest?.published_at && (
                <Text size='sm' c='dimmed'>
                  {t('list.published', {})}: <FormattedTimestamp timestamp={latest.published_at} />
                </Text>
              )}
            </Group>
            <Group gap='xs'>
              {entryBadges(entry).map((badge) => (
                <Badge key={badge.kind} color={badge.color} variant='light' size='sm'>
                  {badgeLabel(badge)}
                </Badge>
              ))}
            </Group>
          </Stack>

          <Group gap='xs' className='shrink-0'>
            {canToggle && (
              <Switch
                size='sm'
                label={entry.updates_enabled ? t('actions.updatesOn', {}) : t('actions.updatesOff', {})}
                checked={entry.updates_enabled}
                disabled={toggling}
                onChange={(event) => onToggleUpdates(entry, event.currentTarget.checked)}
              />
            )}
            {manageable && canInstall(entry) && (
              <Button size='xs' loading={loading} disabled={locked} onClick={() => onInstall(entry)}>
                {installed ? t('actions.update', {}) : t('actions.install', {})}
              </Button>
            )}
            {manageable && installed && entry.rollback && (
              <Button
                size='xs'
                variant='default'
                leftSection={<FontAwesomeIcon icon={faArrowRotateLeft} />}
                disabled={locked}
                onClick={() => onRollback(entry)}
              >
                {t('actions.rollback', { version: entry.rollback.version })}
              </Button>
            )}
          </Group>
        </div>

        {offered && !offered.verified && (
          <Text size='sm' c='orange'>
            {t('list.unverifiedHint', { version: offered.version })}
          </Text>
        )}
        {held && (
          <Text size='sm' c='dimmed'>
            {t('list.updatesOffHint', { version: held.version })}
          </Text>
        )}
        {entry.needs_panel && (
          <Text size='sm' c='yellow'>
            {t('list.needsPanelHint', {
              version: entry.needs_panel.version,
              range: entry.needs_panel.panel_version,
            })}
          </Text>
        )}

        <Group gap='md'>
          {latest?.asset && (
            <Anchor size='sm' href={latest.asset.download_url} {...external}>
              <FontAwesomeIcon icon={faDownload} /> {t('actions.download', {})} {latest.version}
            </Anchor>
          )}
          {latest && (
            <Anchor size='sm' href={latest.html_url} {...external}>
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} /> {t('actions.release', {})} {latest.tag}
            </Anchor>
          )}
          {entry.repo_url && (
            <Anchor size='sm' href={entry.repo_url} {...external}>
              <FontAwesomeIcon icon={faGithub} /> {t('actions.github', {})}
            </Anchor>
          )}
          {entry.notes.length > 0 && (
            <Button size='compact-sm' variant='subtle' onClick={() => setNotesOpen((open) => !open)}>
              {notesOpen ? t('list.hideNotes', {}) : t('list.notes', { count: entry.notes.length })}
            </Button>
          )}
        </Group>

        {entry.notes.length > 0 && (
          <Collapse expanded={notesOpen}>
            <Stack gap='md'>
              {entry.notes.map((release) => (
                <Stack key={release.tag} gap={4}>
                  <Group gap='xs'>
                    <Anchor fw={600} href={release.html_url} {...external}>
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
