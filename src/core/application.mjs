import { createLogger } from '../shared/logger.mjs';

export const APPLICATION_NAME = 'waifu-assistant';
export const APPLICATION_VERSION = '0.1.0';

export function createApplication({
  logger = createLogger(),
  version = APPLICATION_VERSION,
} = {}) {
  let state = 'idle';

  return {
    name: APPLICATION_NAME,
    version,
    getState() {
      return state;
    },
    start() {
      if (state === 'running') {
        return state;
      }

      state = 'running';
      logger.info('Application started', {
        application: APPLICATION_NAME,
        version,
        state,
      });
      return state;
    },
    stop() {
      if (state === 'stopped') {
        return state;
      }

      state = 'stopped';
      logger.info('Application stopped', {
        application: APPLICATION_NAME,
        state,
      });
      return state;
    },
  };
}
