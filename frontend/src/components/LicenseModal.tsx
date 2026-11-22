import { ModalProps } from '@mantine/core';
import { useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/buttons/Button.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import Code from '@/elements/typography/Code.tsx';
import Text from '@/elements/typography/Text.tsx';
import Title from '@/elements/typography/Title.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useTranslations } from '@/providers/TranslationProvider.tsx';
import type { LicenseNeeded } from '../lib/types.ts';
import { useExtTranslations } from '../translations.ts';

type Props = Omit<ModalProps, 'children' | 'title'> & {
  licenses: LicenseNeeded[];
  /** Sends the update again with these licenses accepted. */
  onAccept: () => Promise<void>;
};

export default function LicenseModal({ licenses, onAccept, ...props }: Props) {
  const { t } = useTranslations();
  const { t: tExt } = useExtTranslations();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);

  const accept = async () => {
    setLoading(true);
    try {
      await onAccept();
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={tExt('license.title', {})} size='lg' {...props}>
      <Stack>
        <Text size='sm'>{tExt('license.content', {})}</Text>
        {licenses.map((license) => (
          <Stack key={license.package_name} gap='xs'>
            <Title order={5}>
              {license.name} {license.version}
            </Title>
            <div className='overflow-y-auto max-h-64'>
              <Code block className='whitespace-pre-wrap'>
                {license.license}
              </Code>
            </div>
          </Stack>
        ))}
        <ModalFooter>
          <Button loading={loading} onClick={accept}>
            {tExt('license.accept', {})}
          </Button>
          <Button variant='default' onClick={props.onClose}>
            {t('common.button.cancel', {})}
          </Button>
        </ModalFooter>
      </Stack>
    </Modal>
  );
}
