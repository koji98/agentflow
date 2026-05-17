export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export class MissingCredentialError extends CredentialError {
  readonly scope: string;
  readonly key: string;

  constructor(scope: string, key: string) {
    super(`Missing required credential "${scope}.${key}".`);
    this.name = "MissingCredentialError";
    this.scope = scope;
    this.key = key;
  }
}
