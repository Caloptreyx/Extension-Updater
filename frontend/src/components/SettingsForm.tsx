import { faKey } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/buttons/Button.tsx';
import Alert from '@/elements/feedback/Alert.tsx';
import Spinner from '@/elements/feedback/Spinner.tsx';
import Checkbox from '@/elements/input/Checkbox.tsx';
import NumberInput from '@/elements/input/NumberInput.tsx';
import PasswordInput from '@/elements/input/PasswordInput.tsx';
import Switch from '@/elements/input/Switch.tsx';
import Group from '@/elements/layout/Group.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import type { Settings } from '../lib/types.ts';
import { getSettings, PACKAGE, updateSettings } from '../api.ts';
import { useExtTranslations } from '../translations.ts';

export const settingsKey = [PACKAGE, 'settings'] as const;

/** The updater's settings; the extension card's configuration page and a section of the updater page. */
export default function SettingsForm() {
  const { t } = useExtTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const canRead = useAdminCan('extensions.read');
  const canManage = useAdminCan('extensions.manage');
  const query = useQuery({ queryKey: settingsKey, queryFn: getSettings, enabled: canRead });
  const [form, setForm] = useState<Settings | null>(null);
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  if (query.isLoading) {
    return (
      <Group justify='center' py='lg'>
        <Spinner />
      </Group>
    );
  }
  if (query.error || !form) {
    return <Alert color='red'>{query.error ? httpErrorToHuman(query.error) : null}</Alert>;
  }

  const update = (patch: Partial<Settings>) => setForm({ ...form, ...patch });
  const stored = form.github_token;
  const tokenState = stored.set
    ? stored.hint
      ? t('settings.tokenStored', { hint: stored.hint })
      : t('settings.tokenStoredNoHint', {})
    : t('settings.tokenNone', {});

  const save = async () => {
    setSaving(true);
    try {
      const saved = await updateSettings({
        check_interval_hours: form.check_interval_hours,
        allow_prereleases: form.allow_prereleases,
        auto_update: form.auto_update,
        auto_update_hour: form.auto_update_hour,
        show_banner: form.show_banner,
        // "" removes the stored token, null keeps it
        github_token: removeToken ? '' : token.trim() || null,
      });
      setForm(saved);
      setToken('');
      setRemoveToken(false);
      queryClient.setQueryData(settingsKey, saved);
      queryClient.invalidateQueries({ queryKey: [PACKAGE] });
      addToast(t('settings.saved', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack>
      <NumberInput
        label={t('settings.interval', {})}
        min={1}
        max={168}
        allowDecimal={false}
        value={form.check_interval_hours}
        onChange={(value) => typeof value === 'number' && update({ check_interval_hours: value })}
        disabled={!canManage}
      />
      <Switch
        label={t('settings.prereleases', {})}
        checked={form.allow_prereleases}
        onChange={(event) => update({ allow_prereleases: event.currentTarget.checked })}
        disabled={!canManage}
      />
      <Switch
        label={t('settings.autoUpdate', {})}
        description={t('settings.autoUpdateDescription', {})}
        checked={form.auto_update}
        onChange={(event) => update({ auto_update: event.currentTarget.checked })}
        disabled={!canManage}
      />
      <NumberInput
        label={t('settings.autoUpdateHour', {})}
        description={t('settings.autoUpdateHourDescription', {})}
        min={0}
        max={23}
        allowDecimal={false}
        value={form.auto_update_hour}
        onChange={(value) => typeof value === 'number' && update({ auto_update_hour: value })}
        disabled={!canManage || !form.auto_update}
      />
      <Switch
        label={t('settings.banner', {})}
        checked={form.show_banner}
        onChange={(event) => update({ show_banner: event.currentTarget.checked })}
        disabled={!canManage}
      />
      <PasswordInput
        label={t('settings.token', {})}
        description={`${t('settings.tokenDescription', {})} ${tokenState}`}
        leftSection={<FontAwesomeIcon icon={faKey} />}
        value={token}
        onChange={(event) => setToken(event.currentTarget.value)}
        disabled={!canManage || removeToken}
      />
      {stored.set && (
        <Checkbox
          label={t('settings.removeToken', {})}
          checked={removeToken}
          onChange={(event) => setRemoveToken(event.currentTarget.checked)}
          disabled={!canManage}
        />
      )}
      {canManage && (
        <Group justify='flex-end'>
          <Button loading={saving} onClick={save}>
            {t('settings.save', {})}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
