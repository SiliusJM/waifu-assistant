import { createLogger, type Logger } from '../shared/logger.js';

export const APPLICATION_NAME = 'waifu-assistant';
export const APPLICATION_VERSION = '0.1.0';

export function createApplication({
  logger = createLogger(),
  version = APPLICATION_VERSION,
}: {
  readonly logger?: Logger;
  readonly version?: string;
} = {}) {
  let state: 'idle' | 'running' | 'stopped' = 'idle';

  return {
    name: APPLICATION_NAME,
    version,
    getState(): typeof state {
      return state;
    },
    start(): typeof state {
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
    stop(): typeof state {
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
