import { AssistantError } from '../shared/errors.js';

export interface CredentialReference {
  readonly credentialEnvName: string;
}

export interface CredentialResolver {
  resolve(reference: CredentialReference): string;
}

// The caller may supply an environment snapshot or use the existing process
// configuration. V1 performs no file I/O, persistence, or OS subprocesses.
export class EnvironmentCredentialResolver implements CredentialResolver {
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  resolve(reference: CredentialReference): string {
    const secret = this.#env[reference.credentialEnvName]?.trim();
    if (!secret || /[\r\n\0]/u.test(secret)) {
      throw new AssistantError('The selected provider credential is missing or invalid.', {
        code: 'CONFIGURATION_ERROR', retryable: false,
      });
    }
    return secret;
  }
}
