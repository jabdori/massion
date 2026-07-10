import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export interface EncryptedSecret {
  readonly algorithm: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

export class CredentialVault {
  readonly #masterKey: Buffer;

  public constructor(masterKey: Uint8Array) {
    if (masterKey.byteLength !== 32) throw new Error("Credential master key는 정확히 32-byte여야 합니다");
    this.#masterKey = Buffer.from(masterKey);
  }

  public encrypt(secret: string, aad: string): EncryptedSecret {
    if (!secret) throw new Error("Credential secret은 비어 있을 수 없습니다");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#masterKey, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      algorithm: "aes-256-gcm",
      ciphertext: ciphertext.toString("base64url"),
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  public decrypt(secret: EncryptedSecret, aad: string): string {
    if (secret.algorithm !== "aes-256-gcm") throw new Error(`지원하지 않는 암호화 알고리즘입니다: ${secret.algorithm}`);
    const decipher = createDecipheriv("aes-256-gcm", this.#masterKey, Buffer.from(secret.iv, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(secret.authTag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64url")), decipher.final()]).toString(
      "utf8",
    );
  }

  public fingerprint(secret: string): string {
    return createHmac("sha256", this.#masterKey).update(secret, "utf8").digest("hex");
  }
}
