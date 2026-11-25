import { faCheck, faExclamationTriangle, faKey, faLink, faPaperPlane, faPlug } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/buttons/Button.tsx';
import Badge from '@/elements/data-display/Badge.tsx';
import Alert from '@/elements/feedback/Alert.tsx';
import Spinner from '@/elements/feedback/Spinner.tsx';
import Checkbox from '@/elements/input/Checkbox.tsx';
import NumberInput from '@/elements/input/NumberInput.tsx';
import PasswordInput from '@/elements/input/PasswordInput.tsx';
import Select from '@/elements/input/Select.tsx';
import Switch from '@/elements/input/Switch.tsx';
import Divider from '@/elements/layout/Divider.tsx';
import Group from '@/elements/layout/Group.tsx';
import Stack from '@/elements/layout/Stack.tsx';
import Text from '@/elements/typography/Text.tsx';
import Title from '@/elements/typography/Title.tsx';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import type { RateLimit, Settings, TokenTestResult, WebhookTestResult } from '../lib/types.ts';
import { getSettings, PACKAGE, testDiscordWebhook, testToken, updateSettings } from '../api.ts';
import { useExtTranslations } from '../translations.ts';

export const settingsKey = [PACKAGE, 'settings'] as const;

export interface SettingsFormProps {
  rateLimit?: RateLimit | null;
  timezone?: string;
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => {
  const padded = String(hour).padStart(2, '0');
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const period = hour < 12 ? 'AM' : 'PM';
  return {
    value: String(hour),
    label: `${padded}:00 (${hour12}:00 ${period})`,
  };
});

/** The updater's settings; works both inside the Settings tab and standalone on the Extensions page. */
export default function SettingsForm({ rateLimit: propRateLimit, timezone: propTimezone }: SettingsFormProps = {}) {
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
  const [testing, setTesting] = useState(false);
  const [tokenTest, setTokenTest] = useState<TokenTestResult | null>(null);
  const [webhook, setWebhook] = useState('');
  const [removeWebhook, setRemoveWebhook] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [webhookTest, setWebhookTest] = useState<WebhookTestResult | null>(null);

  useEffect(() => {
    if (query.data?.settings) setForm(query.data.settings);
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
  const timezone = propTimezone || query.data?.timezone || '';
  const liveRateLimit = propRateLimit ?? query.data?.rate_limit ?? null;

  const tokenState = stored.set
    ? stored.hint
      ? t('settings.tokenStored', { hint: stored.hint })
      : t('settings.tokenStoredNoHint', {})
    : t('settings.tokenNone', {});

  const webhookState = form.discord_webhook_configured
    ? t('settings.discordWebhookConfigured', {})
    : t('settings.discordWebhookNone', {});

  const canTestToken = canManage && (token.trim().length > 0 || (stored.set && !removeToken));
  const canTestWebhook = canManage && !removeWebhook && (webhook.trim().length > 0 || form.discord_webhook_configured);

  const runTokenTest = async () => {
    setTesting(true);
    setTokenTest(null);
    try {
      const provided = token.trim() || null;
      const result = await testToken(provided);
      setTokenTest(result);
      if (provided === null && result.valid) {
        queryClient.invalidateQueries({ queryKey: [PACKAGE] });
      }
    } catch (error) {
      setTokenTest({ valid: false, rate_limit: null, error: httpErrorToHuman(error) });
    } finally {
      setTesting(false);
    }
  };

  const runWebhookTest = async () => {
    setTestingWebhook(true);
    setWebhookTest(null);
    try {
      const provided = webhook.trim() || null;
      await testDiscordWebhook(provided);
      setWebhookTest({ valid: true, error: null });
    } catch (error) {
      setWebhookTest({ valid: false, error: httpErrorToHuman(error) });
    } finally {
      setTestingWebhook(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload: Parameters<typeof updateSettings>[0] = {
        check_interval_hours: form.check_interval_hours,
        allow_prereleases: form.allow_prereleases,
        auto_update: form.auto_update,
        auto_update_hour: form.auto_update_hour,
        show_banner: form.show_banner,
        // "" removes the stored token, null keeps it
        github_token: removeToken ? '' : token.trim() || null,
        discord_enabled: removeWebhook ? false : form.discord_enabled,
      };
      if (removeWebhook) {
        payload.discord_webhook_url = '';
      } else if (webhook.trim().length > 0) {
        payload.discord_webhook_url = webhook.trim();
      }
      const saved = await updateSettings(payload);
      setForm(saved.settings);
      setToken('');
      setRemoveToken(false);
      setTokenTest(null);
      setWebhook('');
      setRemoveWebhook(false);
      setWebhookTest(null);
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
    <Stack gap='lg'>
      <Stack gap='sm'>
        <Title order={5}>{t('settings.sectionChecks', {})}</Title>
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
      </Stack>

      <Divider />

      <Stack gap='sm'>
        <Title order={5}>{t('settings.sectionAuto', {})}</Title>
        <Switch
          label={t('settings.autoUpdate', {})}
          description={t('settings.autoUpdateDescription', {})}
          checked={form.auto_update}
          onChange={(event) => update({ auto_update: event.currentTarget.checked })}
          disabled={!canManage}
        />
        <Select
          label={t('settings.autoUpdateHour', {})}
          description={
            timezone ? t('settings.autoUpdateHourDescription', { timezone }) : t('settings.autoUpdateHourFallback', {})
          }
          data={HOUR_OPTIONS}
          value={String(form.auto_update_hour)}
          onChange={(value) => {
            if (value !== null) update({ auto_update_hour: Number(value) });
          }}
          disabled={!canManage || !form.auto_update}
        />
      </Stack>

      <Divider />

      <Stack gap='sm'>
        <Title order={5}>{t('settings.sectionNotifications', {})}</Title>
        <Switch
          label={t('settings.banner', {})}
          checked={form.show_banner}
          onChange={(event) => update({ show_banner: event.currentTarget.checked })}
          disabled={!canManage}
        />
      </Stack>

      <Divider />

      <Stack gap='sm'>
        <Title order={5}>{t('settings.sectionDiscord', {})}</Title>
        <Switch
          label={t('settings.discordEnabled', {})}
          description={t('settings.discordEnabledDescription', {})}
          checked={form.discord_enabled}
          onChange={(event) => update({ discord_enabled: event.currentTarget.checked })}
          disabled={!canManage || removeWebhook}
        />

        <div className='flex flex-col sm:flex-row sm:items-end gap-2'>
          <div className='flex-1'>
            <PasswordInput
              label={t('settings.discordWebhookUrl', {})}
              description={`${t('settings.discordWebhookDescription', {})} ${webhookState}`}
              leftSection={<FontAwesomeIcon icon={faLink} />}
              value={webhook}
              onChange={(event) => {
                setWebhook(event.currentTarget.value);
                setWebhookTest(null);
              }}
              disabled={!canManage || removeWebhook}
            />
          </div>
          {canManage && (
            <Button
              variant='default'
              leftSection={<FontAwesomeIcon icon={faPaperPlane} />}
              loading={testingWebhook}
              disabled={!canTestWebhook}
              onClick={runWebhookTest}
            >
              {t('settings.testDiscordWebhook', {})}
            </Button>
          )}
        </div>

        {webhookTest && (
          <Alert
            color={webhookTest.valid ? 'green' : 'red'}
            icon={<FontAwesomeIcon icon={webhookTest.valid ? faCheck : faExclamationTriangle} />}
          >
            {webhookTest.valid ? t('settings.discordTestSuccess', {}) : webhookTest.error}
          </Alert>
        )}

        {form.discord_webhook_configured && (
          <Checkbox
            label={t('settings.removeDiscordWebhook', {})}
            checked={removeWebhook}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setRemoveWebhook(checked);
              setWebhookTest(null);
              if (checked) {
                update({ discord_enabled: false });
              }
            }}
            disabled={!canManage}
          />
        )}
      </Stack>

      <Divider />

      <Stack gap='sm'>
        <Group justify='space-between' align='center' wrap='wrap'>
          <Title order={5}>{t('settings.sectionGithub', {})}</Title>
          {liveRateLimit ? (
            <Badge
              variant='light'
              color={liveRateLimit.remaining < 15 ? 'orange' : liveRateLimit.authenticated ? 'green' : 'gray'}
              size='sm'
            >
              {t(liveRateLimit.authenticated ? 'status.rateLimitAuthenticated' : 'status.rateLimitUnauthenticated', {
                remaining: liveRateLimit.remaining,
                limit: liveRateLimit.limit,
                time: new Date(liveRateLimit.reset * 1000).toLocaleTimeString(),
              })}
            </Badge>
          ) : (
            <Text size='xs' c='dimmed'>
              {t('status.rateLimitUnknown', {})}
            </Text>
          )}
        </Group>

        <div className='flex flex-col sm:flex-row sm:items-end gap-2'>
          <div className='flex-1'>
            <PasswordInput
              label={t('settings.token', {})}
              description={`${t('settings.tokenDescription', {})} ${tokenState}`}
              leftSection={<FontAwesomeIcon icon={faKey} />}
              value={token}
              onChange={(event) => {
                setToken(event.currentTarget.value);
                setTokenTest(null);
              }}
              disabled={!canManage || removeToken}
            />
          </div>
          {canManage && (
            <Button
              variant='default'
              leftSection={<FontAwesomeIcon icon={faPlug} />}
              loading={testing}
              disabled={!canTestToken}
              onClick={runTokenTest}
            >
              {t('settings.testToken', {})}
            </Button>
          )}
        </div>

        {tokenTest && (
          <Alert
            color={tokenTest.valid ? 'green' : 'red'}
            icon={<FontAwesomeIcon icon={tokenTest.valid ? faCheck : faExclamationTriangle} />}
          >
            {tokenTest.valid
              ? tokenTest.rate_limit
                ? t('settings.tokenValid', {
                    remaining: tokenTest.rate_limit.remaining,
                    limit: tokenTest.rate_limit.limit,
                    time: new Date(tokenTest.rate_limit.reset * 1000).toLocaleTimeString(),
                  })
                : t('settings.tokenValidNoRate', {})
              : tokenTest.error}
          </Alert>
        )}

        {stored.set && (
          <Checkbox
            label={t('settings.removeToken', {})}
            checked={removeToken}
            onChange={(event) => {
              setRemoveToken(event.currentTarget.checked);
              setTokenTest(null);
            }}
            disabled={!canManage}
          />
        )}
      </Stack>

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
