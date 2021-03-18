import { ActionTree } from 'vuex';
import {
  convertToAccountingSettings,
  convertToGeneralSettings
} from '@/data/converters';
import i18n from '@/i18n';
import { DBSettings } from '@/model/action-result';
import { createTask, taskCompletion, TaskMeta } from '@/model/task';
import { TaskType } from '@/model/task-type';
import { balanceKeys } from '@/services/consts';
import { monitor } from '@/services/monitoring';
import { api } from '@/services/rotkehlchen-api';
import {
  QueriedAddressPayload,
  Watcher,
  WatcherTypes
} from '@/services/session/types';
import { SYNC_DOWNLOAD, SyncAction } from '@/services/types-api';
import { Severity } from '@/store/notifications/consts';
import { notify } from '@/store/notifications/utils';
import {
  ChangePasswordPayload,
  PremiumCredentialsPayload,
  SessionState
} from '@/store/session/types';
import {
  LAST_KNOWN_TIMEFRAME,
  TIMEFRAME_REMEMBER,
  TIMEFRAME_SETTING
} from '@/store/settings/consts';
import { loadFrontendSettings } from '@/store/settings/utils';
import { ActionStatus, Message, RotkehlchenState } from '@/store/types';
import { showError, showMessage } from '@/store/utils';
import {
  SettingsUpdate,
  SyncConflictError,
  Tag,
  UnlockPayload
} from '@/typing/types';
import { backoff } from '@/utils/backoff';

const periodic = {
  isRunning: false
};

export const actions: ActionTree<SessionState, RotkehlchenState> = {
  start({ commit }, payload: { settings: DBSettings }) {
    const { settings } = payload;

    commit('premium', settings.have_premium);
    commit('premiumSync', settings.premium_should_sync);
    commit('updateLastBalanceSave', settings.last_balance_save);
    commit('updateLastDataUpload', settings.last_data_upload_ts);
    commit('generalSettings', convertToGeneralSettings(settings));
    commit('accountingSettings', convertToAccountingSettings(settings));
  },
  async unlock(
    { commit, dispatch, state, rootState },
    payload: UnlockPayload
  ): Promise<ActionStatus> {
    let settings: DBSettings;
    let exchanges: string[];

    try {
      const { username, create } = payload;
      const isLogged = await api.checkIfLogged(username);
      if (isLogged && !state.syncConflict.message) {
        [settings, exchanges] = await Promise.all([
          api.getSettings(),
          api.getExchanges()
        ]);
      } else {
        commit('syncConflict', { message: '', payload: null });
        ({ settings, exchanges } = await api.unlockUser(payload));
      }

      if (settings.frontend_settings) {
        loadFrontendSettings(commit, settings.frontend_settings);
        const timeframeSetting = rootState.settings![TIMEFRAME_SETTING];
        if (timeframeSetting !== TIMEFRAME_REMEMBER) {
          commit('setTimeframe', timeframeSetting);
        } else {
          commit('setTimeframe', rootState.settings![LAST_KNOWN_TIMEFRAME]);
        }
      }

      await dispatch('start', {
        settings
      });

      monitor.start();
      commit('tags', await api.getTags());
      commit('login', { username, newAccount: create });

      const options = {
        root: true
      };
      const async = [
        dispatch('fetchIgnoredAssets'),
        dispatch('balances/fetchSupportedAssets', null, options),
        dispatch('session/fetchWatchers', null, options),
        dispatch('balances/fetchManualBalances', null, options),
        dispatch('statistics/fetchNetValue', null, options),
        dispatch(
          'balances/fetch',
          {
            newUser: create,
            exchanges
          },
          options
        ),
        dispatch('balances/fetchLoopringBalances', false, options)
      ];

      Promise.all(async).then(() =>
        dispatch('balances/refreshPrices', false, options)
      );
      return { success: true };
    } catch (e) {
      if (e instanceof SyncConflictError) {
        commit('syncConflict', { message: e.message, payload: e.payload });
        return { success: false, message: '' };
      }
      return { success: false, message: e.message };
    }
  },
  async periodicCheck({
    commit,
    state: {
      lastBalanceSave: lastKnownBalanceSave,
      lastDataUpload,
      nodeConnection
    }
  }) {
    if (periodic.isRunning) {
      return;
    }
    periodic.isRunning = true;
    try {
      const result = await backoff(3, () => api.queryPeriodicData(), 10000);
      if (Object.keys(result).length === 0) {
        // an empty object means user is not logged in yet
        return;
      }

      const { lastBalanceSave, ethNodeConnection, lastDataUploadTs } = result;

      if (lastBalanceSave !== lastKnownBalanceSave) {
        commit('updateLastBalanceSave', lastBalanceSave);
      }

      if (ethNodeConnection !== nodeConnection) {
        commit('nodeConnection', ethNodeConnection);
      }

      if (lastDataUploadTs !== lastDataUpload) {
        commit('updateLastDataUpload', lastDataUploadTs);
      }
    } catch (e) {
      notify(
        i18n
          .t('actions.session.periodic_query.error.message', {
            message: e.message
          })
          .toString(),
        i18n.t('actions.session.periodic_query.error.title').toString(),
        Severity.ERROR,
        true
      );
    } finally {
      periodic.isRunning = false;
    }
  },
  async logout({ dispatch, state }) {
    try {
      await api.logout(state.username);
      await dispatch('stop');
    } catch (e) {
      showError(e.message, 'Logout failed');
    }
  },
  async stop({ commit }) {
    monitor.stop();
    const opts = { root: true };
    const payload = {};
    commit('session/reset', payload, opts);
    commit('notifications/reset', payload, opts);
    commit('reports/reset', payload, opts);
    commit('balances/reset', payload, opts);
    commit('defi/reset', payload, opts);
    commit('tasks/reset', payload, opts);
    commit('settings/reset', payload, opts);
    commit('history/reset', payload, opts);
    commit('statistics/reset', payload, opts);
    commit('staking/reset', payload, opts);
    commit('reset', payload, opts);
  },

  async addTag({ commit }, tag: Tag) {
    try {
      commit('tags', await api.addTag(tag));
    } catch (e) {
      showError(
        e.message,
        i18n.t('actions.session.tag_add.error.title').toString()
      );
    }
  },

  async editTag({ commit }, tag: Tag) {
    try {
      commit('tags', await api.editTag(tag));
    } catch (e) {
      showError(
        e.message,
        i18n.t('actions.session.tag_edit.error.title').toString()
      );
    }
  },

  async deleteTag({ commit, dispatch }, tagName: string) {
    try {
      commit('tags', await api.deleteTag(tagName));
    } catch (e) {
      showError(
        e.message,
        i18n.t('actions.session.tag_delete.error.title').toString()
      );
    }
    dispatch('balances/removeTag', tagName, { root: true });
  },

  async setKrakenAccountType({ commit }, account_type: string) {
    try {
      const settings = await api.setSettings({
        kraken_account_type: account_type
      });
      commit('generalSettings', convertToGeneralSettings(settings));
      commit(
        'setMessage',
        {
          title: i18n
            .t('actions.session.kraken_account.success.title')
            .toString(),
          description: i18n
            .t('actions.session.kraken_account.success.message')
            .toString(),
          success: true
        } as Message,
        { root: true }
      );
    } catch (e) {
      showError(
        e.message,
        i18n.t('actions.session.kraken_account.error.title').toString()
      );
    }
  },

  //TODO: migrate to settingsUpdate in the future
  async updateSettings({ dispatch }, update: SettingsUpdate): Promise<void> {
    const { success, message } = await dispatch('settingsUpdate', update);
    if (!success) {
      showError(
        i18n
          .t('actions.session.settings_update.error.message', { message })
          .toString()
      );
    }
  },

  async settingsUpdate(
    { commit, state },
    update: SettingsUpdate
  ): Promise<ActionStatus> {
    let success = false;
    let message = '';
    try {
      const settings = await api.setSettings(update);
      if (state.premium !== settings.have_premium) {
        commit('premium', settings.have_premium);
      }

      if (state.premiumSync !== settings.premium_should_sync) {
        commit('premiumSync', settings.premium_should_sync);
      }

      commit('generalSettings', convertToGeneralSettings(settings));
      commit('accountingSettings', convertToAccountingSettings(settings));
      success = true;
    } catch (e) {
      message = e.message;
    }
    return {
      success,
      message
    };
  },

  async fetchWatchers({ commit, rootState: { session } }) {
    if (!session?.premium) {
      return;
    }

    try {
      const watchers = await api.session.watchers();
      commit('watchers', watchers);
    } catch (e) {
      notify(
        i18n
          .t('actions.session.fetch_watchers.error.message', {
            message: e.message
          })
          .toString(),
        i18n.t('actions.session.fetch_watchers.error.title').toString(),
        Severity.ERROR,
        true
      );
    }
  },

  async addWatchers(
    { commit },
    watchers: Omit<Watcher<WatcherTypes>, 'identifier'>[]
  ) {
    const updatedWatchers = await api.session.addWatcher(watchers);
    commit('watchers', updatedWatchers);
    return updatedWatchers;
  },

  async deleteWatchers({ commit }, identifiers: string[]) {
    const updatedWatchers = await api.session.deleteWatcher(identifiers);
    commit('watchers', updatedWatchers);
    return updatedWatchers;
  },

  async editWatchers({ commit }, watchers: Watcher<WatcherTypes>[]) {
    const updatedWatchers = await api.session.editWatcher(watchers);
    commit('watchers', updatedWatchers);
    return updatedWatchers;
  },

  async fetchQueriedAddresses({ commit }) {
    try {
      const queriedAddresses = await api.session.queriedAddresses();
      commit('queriedAddresses', queriedAddresses);
    } catch (e) {
      showError(
        i18n
          .t('actions.session.fetch_queriable_address.error.message', {
            message: e.message
          })
          .toString()
      );
    }
  },

  async addQueriedAddress({ commit }, payload: QueriedAddressPayload) {
    try {
      const queriedAddresses = await api.session.addQueriedAddress(payload);
      commit('queriedAddresses', queriedAddresses);
    } catch (e) {
      showError(
        i18n
          .t('actions.session.add_queriable_address.error.message', {
            message: e.message
          })
          .toString()
      );
    }
  },

  async deleteQueriedAddress({ commit }, payload: QueriedAddressPayload) {
    try {
      const queriedAddresses = await api.session.deleteQueriedAddress(payload);
      commit('queriedAddresses', queriedAddresses);
    } catch (e) {
      showError(
        i18n
          .t('actions.session.delete_queriable_address.error.message', {
            message: e.message
          })
          .toString()
      );
    }
  },

  async setupPremium(
    { commit },
    { apiKey, apiSecret, username }: PremiumCredentialsPayload
  ): Promise<ActionStatus> {
    try {
      const success = await api.setPremiumCredentials(
        username,
        apiKey,
        apiSecret
      );

      if (success) {
        commit('premium', true);
      }
      return { success };
    } catch (e) {
      return {
        success: false,
        message: e.message
      };
    }
  },

  async deletePremium({ commit }): Promise<ActionStatus> {
    try {
      const success = await api.deletePremiumCredentials();
      if (success) {
        commit('premium', false);
      }
      return { success };
    } catch (e) {
      return {
        success: false,
        message: e.message
      };
    }
  },

  async changePassword(
    { state: { username } },
    { currentPassword, newPassword }: ChangePasswordPayload
  ): Promise<ActionStatus> {
    try {
      const success = await api.changeUserPassword(
        username,
        currentPassword,
        newPassword
      );
      showMessage(i18n.t('actions.session.password_change.success').toString());
      return {
        success
      };
    } catch (e) {
      showError(i18n.t('actions.session.password_change.error').toString());
      return {
        success: false,
        message: e.message
      };
    }
  },

  async fetchIgnoredAssets({ commit }): Promise<void> {
    try {
      const ignoredAssets = await api.assets.ignoredAssets();
      commit('ignoreAssets', ignoredAssets);
    } catch (e) {
      const title = i18n.tc('actions.session.ignored_assets.error.title');
      const message = i18n.tc(
        'actions.session.ignored_assets.error.message',
        0,
        {
          error: e.message
        }
      );
      notify(message, title, Severity.ERROR, true);
    }
  },
  async ignoreAsset({ commit }, asset: string): Promise<ActionStatus> {
    try {
      const ignoredAssets = await api.assets.modifyAsset(true, asset);
      commit('ignoreAssets', ignoredAssets);
      return { success: true };
    } catch (e) {
      const title = i18n.tc('actions.session.ignore_asset.error.title');
      const message = i18n.tc('actions.session.ignore_asset.error.message', 0, {
        error: e.message
      });
      notify(message, title, Severity.ERROR, true);
      return { success: false, message: e.message };
    }
  },
  async unignoreAsset({ commit }, asset: string): Promise<ActionStatus> {
    try {
      const ignoredAssets = await api.assets.modifyAsset(false, asset);
      commit('ignoreAssets', ignoredAssets);
      return { success: true };
    } catch (e) {
      const title = i18n.tc('actions.session.unignore_asset.error.title');
      const message = i18n.tc(
        'actions.session.unignore_asset.error.message',
        0,
        {
          error: e.message
        }
      );
      notify(message, title, Severity.ERROR, true);
      return { success: false, message: e.message };
    }
  },
  async forceSync(
    { commit, dispatch, rootGetters: { 'tasks/isTaskRunning': isTaskRunning } },
    action: SyncAction
  ): Promise<void> {
    const taskType = TaskType.FORCE_SYNC;
    if (isTaskRunning(taskType)) {
      return;
    }
    try {
      const { taskId } = await api.forceSync(action);
      const task = createTask(taskId, taskType, {
        title: i18n.tc('actions.session.force_sync.task.title'),
        ignoreResult: false,
        numericKeys: balanceKeys
      });
      commit('tasks/add', task, { root: true });
      await taskCompletion<boolean, TaskMeta>(taskType);
      const title = i18n.tc('actions.session.force_sync.success.title');
      const message = i18n.tc('actions.session.force_sync.success.message');
      notify(message, title, Severity.INFO, true);

      if (action === SYNC_DOWNLOAD) {
        await dispatch('logout');
      }
    } catch (e) {
      const title = i18n.tc('actions.session.force_sync.error.title');
      const message = i18n.tc('actions.session.force_sync.error.message', 0, {
        error: e.message
      });
      notify(message, title, Severity.ERROR, true);
    }
  }
};
