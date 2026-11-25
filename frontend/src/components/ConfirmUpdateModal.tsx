import { faArrowRight, faChevronDown, faChevronRight, faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { ModalProps } from '@mantine/core';
import { useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/buttons/Button.tsx';
import Badge from '@/elements/data-display/Badge.tsx';
import Card from '@/elements/data-display/Card.tsx';
import Alert from '@/elements/feedback/Alert.tsx';
import Collapse from '@/elements/layout/Collapse.tsx';
import Group from '@/elements/layout/Group.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import Text from '@/elements/typography/Text.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useTranslations } from '@/providers/TranslationProvider.tsx';
import type { Entry, UpdateRequest } from '../lib/types.ts';
import { useExtTranslations } from '../translations.ts';
import ReleaseNotes from './ReleaseNotes.tsx';

export interface ConfirmUpdateTarget {
  entries: Entry[];
  request: UpdateRequest;
}

type Props = Omit<ModalProps, 'children' | 'title'> & {
  target: ConfirmUpdateTarget | null;
  onConfirm: (request: UpdateRequest) => Promise<void>;
};

export default function ConfirmUpdateModal({ target, onConfirm, ...props }: Props) {
  const { t } = useTranslations();
  const { t: tExt } = useExtTranslations();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  const entries = target?.entries ?? [];
  const request = target?.request;

  const entriesWithNotes = entries
    .map((entry) => {
      const releases =
        entry.notes.length > 0
          ? entry.notes.filter((r) => r.body.trim().length > 0)
          : entry.latest && entry.latest.body.trim().length > 0
            ? [entry.latest]
            : [];
      return { entry, releases };
    })
    .filter((item) => item.releases.length > 0);

  const confirm = async () => {
    if (!request) return;
    setLoading(true);
    try {
      await onConfirm(request);
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={tExt('confirm.title', {})} size='lg' {...props}>
      <Stack gap='md'>
        <Card p='sm'>
          <Stack gap='xs'>
            {entries.map((entry) => {
              const targetVersion =
                request?.packages.find((pkg) => pkg.package_name === entry.package_name)?.version ??
                entry.latest?.version ??
                '';
              return (
                <Group key={entry.package_name} justify='space-between' gap='sm' wrap='wrap'>
                  <Group gap='xs'>
                    <Text size='sm' fw={600}>
                      {entry.name}
                    </Text>
                    {entry.latest?.prerelease && (
                      <Badge size='xs' color='orange' variant='light'>
                        {tExt('list.prerelease', {})}
                      </Badge>
                    )}
                    {!entry.installed && (
                      <Badge size='xs' color='blue' variant='light'>
                        {tExt('confirm.newInstall', {})}
                      </Badge>
                    )}
                  </Group>
                  <Text size='sm' className='font-mono tabular-nums'>
                    {entry.installed ? (
                      <>
                        <span className='opacity-70'>{entry.installed.version}</span>{' '}
                        <FontAwesomeIcon icon={faArrowRight} className='mx-1 opacity-50' size='xs' />{' '}
                        <b>{targetVersion}</b>
                      </>
                    ) : (
                      <b>v{targetVersion}</b>
                    )}
                  </Text>
                </Group>
              );
            })}
          </Stack>
        </Card>

        {request?.force && (
          <Text size='xs' c='dimmed'>
            {tExt('confirm.forceNote', {})}
          </Text>
        )}

        {entriesWithNotes.length > 0 && (
          <Stack gap='xs'>
            <div>
              <Button
                size='compact-sm'
                variant='subtle'
                leftSection={<FontAwesomeIcon icon={notesOpen ? faChevronDown : faChevronRight} size='xs' />}
                onClick={() => setNotesOpen((open) => !open)}
              >
                {tExt('confirm.releaseNotes', {})} ({entriesWithNotes.length})
              </Button>
            </div>
            <Collapse expanded={notesOpen}>
              <Card p='sm' className='max-h-64' style={{ overflowY: 'auto' }}>
                <Stack gap='md'>
                  {entriesWithNotes.map(({ entry, releases }) => (
                    <Stack key={entry.package_name} gap='xs'>
                      <Text size='sm' fw={600}>
                        {entry.name}
                      </Text>
                      {releases.map((release) => (
                        <Stack key={release.tag} gap={4}>
                          <Text size='xs' c='dimmed' fw={600}>
                            {release.name || release.tag}
                          </Text>
                          <ReleaseNotes body={release.body} />
                        </Stack>
                      ))}
                    </Stack>
                  ))}
                </Stack>
              </Card>
            </Collapse>
          </Stack>
        )}

        <Alert color='blue' icon={<FontAwesomeIcon icon={faCircleInfo} />}>
          {tExt('confirm.notice', {})}
        </Alert>

        <ModalFooter>
          <Button loading={loading} onClick={confirm}>
            {tExt('confirm.confirm', {})}
          </Button>
          <Button variant='default' disabled={loading} onClick={props.onClose}>
            {t('common.button.cancel', {})}
          </Button>
        </ModalFooter>
      </Stack>
    </Modal>
  );
}
