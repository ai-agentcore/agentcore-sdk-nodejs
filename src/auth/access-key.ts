import { inspect } from 'node:util';

export interface AccessKeyOptions {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
}

export class AccessKeyCredential {
  #values: AccessKeyOptions;
  constructor(values: AccessKeyOptions) {
    if (!values.accessKeyId?.trim() || !values.accessKeySecret?.trim() ||
      (values.securityToken !== undefined && !values.securityToken.trim())) {
      throw new TypeError('AccessKey ID, secret and optional security token must not be empty');
    }
    this.#values = { ...values };
  }
  get accessKeyId(): string { return this.#values.accessKeyId; }
  get accessKeySecret(): string { return this.#values.accessKeySecret; }
  get securityToken(): string | undefined { return this.#values.securityToken; }
  [inspect.custom](): string { return `AccessKeyCredential(type=${this.securityToken ? 'sts' : 'access_key'}, <redacted>)`; }
  toJSON(): string { return this[inspect.custom](); }
}

export class ResourceCredential extends AccessKeyCredential {
  readonly expiration: Date;
  readonly credentialType = 'ram_sts';
  constructor(values: AccessKeyOptions & { securityToken: string; expiration: Date }) {
    super(values);
    if (!Number.isFinite(values.expiration.getTime())) throw new TypeError('STS expiration must be a valid Date');
    this.expiration = new Date(values.expiration);
  }
  [inspect.custom](): string { return `ResourceCredential(expiration=${this.expiration.toISOString()}, <redacted>)`; }
}

export interface CredentialProvider {
  get(purpose?: string): Promise<AccessKeyCredential> | AccessKeyCredential;
}
