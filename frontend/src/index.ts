import { faCloudArrowDown } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { createElement } from 'react';
import { Extension, type ExtensionContext } from 'shared';
import SettingsForm from './components/SettingsForm.tsx';
import UpdatesBanner from './components/UpdatesBanner.tsx';
import UpdatesCard from './components/UpdatesCard.tsx';
import UpdaterPage from './pages/UpdaterPage.tsx';
import { getExtTranslations } from './translations.ts';

class DevCaloptreyxUpdaterExtension extends Extension {
  public cardIcon = createElement(FontAwesomeIcon, { icon: faCloudArrowDown });
  public cardConfigurationPage: React.FC | null = SettingsForm;

  public initialize(ctx: ExtensionContext): void {
    ctx.extensionRegistry.enterRoutes((routes) =>
      routes.addAdminRoute({
        name: () => getExtTranslations().t('title', {}),
        icon: faCloudArrowDown,
        path: '/extension-updates',
        element: UpdaterPage,
        permission: 'extensions.read',
        category: 'system',
      }),
    );

    // above every admin page while updates are available
    ctx.extensionRegistry.pages.admin.prependComponent(UpdatesBanner);
    ctx.extensionRegistry.pages.admin.enterHome((home) =>
      home.updates.enterCards((cards) => cards.prependComponent(UpdatesCard)),
    );
  }
}

export default new DevCaloptreyxUpdaterExtension();
