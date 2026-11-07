import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import type { FeishuAdminSettings } from '@orbit/shared';
import { api } from '../api';
import { AdminNav } from '../components/AdminNav';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { useToast } from '../lib/toast';

/** `GET` and `PUT /admin/integrations/feishu` (docs/feishu-bot-design.md §4.1). */
export const feishuAdminQuery = () =>
  queryOptions({
    queryKey: ['admin', 'integrations', 'feishu'] as const,
    queryFn: () => api<FeishuAdminSettings>('/admin/integrations/feishu'),
  });

export const ALLOW_FEISHU_LABEL = 'Allow accounts to connect Feishu bots';
export const ALLOW_FEISHU_HINT =
  'Each account connects a Feishu or Lark app of its own. Every app that is switched on is one long connection from '
  + 'each apiserver to Feishu. Turning this off disconnects them all; the apps stay saved.';

/** "3 apps connected, 2 of them on". */
export function connectedAppsText({ connectedApps, enabledApps }: FeishuAdminSettings): string {
  if (connectedApps === 0) return 'No account has connected an app.';
  const apps = connectedApps === 1 ? '1 app connected' : `${connectedApps} apps connected`;
  return enabledApps === connectedApps ? `${apps}, all switched on.` : `${apps}, ${enabledApps} of them switched on.`;
}

/**
 * Admin → Integrations (docs/feishu-bot-design.md §4.1): Feishu bots' one switch, on by default, and how many apps
 * accounts have connected — each a connection from every replica, which is what an operator watches. Saved the
 * moment it is switched.
 */
export function AdminIntegrationsPage() {
  const message = useToast();
  const qc = useQueryClient();
  const settings = useQuery(feishuAdminQuery());
  const switchId = useId();
  const save = useMutation({
    mutationFn: (allowed: boolean) => api<FeishuAdminSettings>('/admin/integrations/feishu', { method: 'PUT', body: { allowed } }),
    onSuccess: (saved) => {
      qc.setQueryData(feishuAdminQuery().queryKey, saved);
      message.success(saved.allowed ? 'Feishu bots allowed' : 'Feishu bots turned off');
    },
    onError: (e: Error) => message.error("Couldn't change the setting", e.message),
  });

  return (
    <div className="admin-page">
      <AdminNav />
      <h1 className="page-title">Integrations</h1>
      {settings.isPending ? (
        <Spinner />
      ) : settings.isError ? (
        <p className="admin-signin-error" role="alert">
          Couldn’t load the integrations: {settings.error.message}
        </p>
      ) : (
        <Card
          title="Feishu bots"
          className="admin-signin"
          extra={<Badge tone={settings.data.allowed ? 'success' : 'default'}>{settings.data.allowed ? 'On' : 'Off'}</Badge>}
        >
          <div className="admin-signin-fields">
            <div className="admin-signin-row">
              <div>
                <div className="admin-signin-label" id={switchId}>
                  {ALLOW_FEISHU_LABEL}
                </div>
                <div className="admin-signin-hint">{ALLOW_FEISHU_HINT}</div>
              </div>
              <Switch
                aria-labelledby={switchId}
                checked={settings.data.allowed}
                loading={save.isPending}
                onCheckedChange={(allowed) => save.mutate(allowed)}
              />
            </div>
            <div className="admin-signin-field">
              <div className="admin-signin-label">Connected apps</div>
              <div className="admin-feishu-count">{connectedAppsText(settings.data)}</div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
