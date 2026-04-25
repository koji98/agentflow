export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export class MissingCredentialError extends CredentialError {
  constructor(scope: string, key: string) {
    super(`Missing required credential "${scope}.${key}".`);
    this.name = "MissingCredentialError";
  }
}
