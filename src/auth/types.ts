export interface CredentialFieldSpec {
  secret: boolean;
  required: boolean;
  description?: string;
  default?: string;
}

export interface CredentialScopeSpec {
  description?: string;
  fields: Record<string, CredentialFieldSpec>;
}

export type CredentialSpecMap = Record<string, CredentialScopeSpec>;

export interface CredentialFieldRef {
  scope: string;
  key: string;
}
