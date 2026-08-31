/*
Vendored type declarations for libsodium-wrappers-sumo.

Assembled from DefinitelyTyped:
  - @types/libsodium-wrappers@0.7.14   (base surface)
  - @types/libsodium-wrappers-sumo@0.7.8 (sumo-only additions)

They are vendored because @types/libsodium-wrappers-sumo re-exports from the
"libsodium-wrappers" *package*, and under Deno that resolves to the runtime
package's own bundled (and incompatible) declarations instead of the pinned
@types package. Vendoring keeps the audited crypto code in packages/crypto
compiling unmodified. Licensed MIT, as DefinitelyTyped is.
*/

export type Uint8ArrayOutputFormat = "uint8array";

export type StringOutputFormat = "text" | "hex" | "base64";

export type KeyType = "curve25519" | "ed25519" | "x25519";

export enum base64_variants {
    ORIGINAL,
    ORIGINAL_NO_PADDING,
    URLSAFE,
    URLSAFE_NO_PADDING,
}

export interface CryptoBox {
    ciphertext: Uint8Array;
    mac: Uint8Array;
}

export interface StringCryptoBox {
    ciphertext: string;
    mac: string;
}

export interface CryptoKX {
    sharedRx: Uint8Array;
    sharedTx: Uint8Array;
}

export interface StringCryptoKX {
    sharedRx: string;
    sharedTx: string;
}

export interface KeyPair {
    keyType: KeyType;
    privateKey: Uint8Array;
    publicKey: Uint8Array;
}

export interface StringKeyPair {
    keyType: KeyType;
    privateKey: string;
    publicKey: string;
}

export interface SecretBox {
    cipher: Uint8Array;
    mac: Uint8Array;
}

export interface StringSecretBox {
    cipher: string;
    mac: string;
}

export interface StateAddress {
    name: string;
}

export interface MessageTag {
    message: Uint8Array;
    tag: number;
}

export interface StringMessageTag {
    message: string;
    tag: number;
}

export const crypto_aead_chacha20poly1305_ABYTES: number;
export const crypto_aead_chacha20poly1305_ietf_ABYTES: number;
export const crypto_aead_chacha20poly1305_IETF_ABYTES: number;
export const crypto_aead_chacha20poly1305_ietf_KEYBYTES: number;
export const crypto_aead_chacha20poly1305_IETF_KEYBYTES: number;
export const crypto_aead_chacha20poly1305_ietf_MESSAGEBYTES_MAX: number;
export const crypto_aead_chacha20poly1305_IETF_MESSAGEBYTES_MAX: number;
export const crypto_aead_chacha20poly1305_ietf_NPUBBYTES: number;
export const crypto_aead_chacha20poly1305_IETF_NPUBBYTES: number;
export const crypto_aead_chacha20poly1305_ietf_NSECBYTES: number;
export const crypto_aead_chacha20poly1305_IETF_NSECBYTES: number;
export const crypto_aead_chacha20poly1305_KEYBYTES: number;
export const crypto_aead_chacha20poly1305_MESSAGEBYTES_MAX: number;
export const crypto_aead_chacha20poly1305_NPUBBYTES: number;
export const crypto_aead_chacha20poly1305_NSECBYTES: number;
export const crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
export const crypto_aead_xchacha20poly1305_IETF_ABYTES: number;
export const crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
export const crypto_aead_xchacha20poly1305_IETF_KEYBYTES: number;
export const crypto_aead_xchacha20poly1305_ietf_MESSAGEBYTES_MAX: number;
export const crypto_aead_xchacha20poly1305_IETF_MESSAGEBYTES_MAX: number;
export const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
export const crypto_aead_xchacha20poly1305_IETF_NPUBBYTES: number;
export const crypto_aead_xchacha20poly1305_ietf_NSECBYTES: number;
export const crypto_aead_xchacha20poly1305_IETF_NSECBYTES: number;
export const crypto_aead_aegis128l_ABYTES: number;
export const crypto_aead_aegis128l_KEYBYTES: number;
export const crypto_aead_aegis128l_MESSAGEBYTES_MAX: number;
export const crypto_aead_aegis128l_NPUBBYTES: number;
export const crypto_aead_aegis128l_NSECBYTES: number;
export const crypto_aead_aegis256_ABYTES: number;
export const crypto_aead_aegis256_KEYBYTES: number;
export const crypto_aead_aegis256_MESSAGEBYTES_MAX: number;
export const crypto_aead_aegis256_NPUBBYTES: number;
export const crypto_aead_aegis256_NSECBYTES: number;
export const crypto_auth_BYTES: number;
export const crypto_auth_KEYBYTES: number;
export const crypto_box_BEFORENMBYTES: number;
export const crypto_box_MACBYTES: number;
export const crypto_box_MESSAGEBYTES_MAX: number;
export const crypto_box_NONCEBYTES: number;
export const crypto_box_PUBLICKEYBYTES: number;
export const crypto_box_SEALBYTES: number;
export const crypto_box_SECRETKEYBYTES: number;
export const crypto_box_SEEDBYTES: number;
export const crypto_generichash_BYTES: number;
export const crypto_generichash_BYTES_MAX: number;
export const crypto_generichash_BYTES_MIN: number;
export const crypto_generichash_KEYBYTES: number;
export const crypto_generichash_KEYBYTES_MAX: number;
export const crypto_generichash_KEYBYTES_MIN: number;
export const crypto_hash_BYTES: number;
export const crypto_kdf_BYTES_MAX: number;
export const crypto_kdf_BYTES_MIN: number;
export const crypto_kdf_CONTEXTBYTES: number;
export const crypto_kdf_KEYBYTES: number;
export const crypto_kx_PUBLICKEYBYTES: number;
export const crypto_kx_SECRETKEYBYTES: number;
export const crypto_kx_SEEDBYTES: number;
export const crypto_kx_SESSIONKEYBYTES: number;
export const crypto_pwhash_ALG_ARGON2I13: number;
export const crypto_pwhash_ALG_ARGON2ID13: number;
export const crypto_pwhash_ALG_DEFAULT: number;
export const crypto_pwhash_BYTES_MAX: number;
export const crypto_pwhash_BYTES_MIN: number;
export const crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
export const crypto_pwhash_MEMLIMIT_MAX: number;
export const crypto_pwhash_MEMLIMIT_MIN: number;
export const crypto_pwhash_MEMLIMIT_MODERATE: number;
export const crypto_pwhash_MEMLIMIT_SENSITIVE: number;
export const crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
export const crypto_pwhash_OPSLIMIT_MAX: number;
export const crypto_pwhash_OPSLIMIT_MIN: number;
export const crypto_pwhash_OPSLIMIT_MODERATE: number;
export const crypto_pwhash_OPSLIMIT_SENSITIVE: number;
export const crypto_pwhash_PASSWD_MAX: number;
export const crypto_pwhash_PASSWD_MIN: number;
export const crypto_pwhash_SALTBYTES: number;
export const crypto_pwhash_STRBYTES: number;
export const crypto_pwhash_STRPREFIX: string;
export const crypto_scalarmult_BYTES: number;
export const crypto_scalarmult_SCALARBYTES: number;
export const crypto_secretbox_KEYBYTES: number;
export const crypto_secretbox_MACBYTES: number;
export const crypto_secretbox_MESSAGEBYTES_MAX: number;
export const crypto_secretbox_NONCEBYTES: number;
export const crypto_secretstream_xchacha20poly1305_ABYTES: number;
export const crypto_secretstream_xchacha20poly1305_HEADERBYTES: number;
export const crypto_secretstream_xchacha20poly1305_KEYBYTES: number;
export const crypto_secretstream_xchacha20poly1305_MESSAGEBYTES_MAX: number;
export const crypto_secretstream_xchacha20poly1305_TAG_FINAL: number;
export const crypto_secretstream_xchacha20poly1305_TAG_MESSAGE: number;
export const crypto_secretstream_xchacha20poly1305_TAG_PUSH: number;
export const crypto_secretstream_xchacha20poly1305_TAG_REKEY: number;
export const crypto_shorthash_BYTES: number;
export const crypto_shorthash_KEYBYTES: number;
export const crypto_sign_BYTES: number;
export const crypto_sign_MESSAGEBYTES_MAX: number;
export const crypto_sign_PUBLICKEYBYTES: number;
export const crypto_sign_SECRETKEYBYTES: number;
export const crypto_sign_SEEDBYTES: number;
export const SODIUM_LIBRARY_VERSION_MAJOR: number;
export const SODIUM_LIBRARY_VERSION_MINOR: number;
export const SODIUM_VERSION_STRING: string;

export const ready: Promise<void>;

export function add(a: Uint8Array, b: Uint8Array): void;

export function compare(b1: Uint8Array, b2: Uint8Array): number;

export function crypto_aead_chacha20poly1305_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_chacha20poly1305_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_chacha20poly1305_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_chacha20poly1305_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_chacha20poly1305_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_chacha20poly1305_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_chacha20poly1305_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): CryptoBox;
export function crypto_aead_chacha20poly1305_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): StringCryptoBox;

export function crypto_aead_chacha20poly1305_ietf_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_chacha20poly1305_ietf_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_chacha20poly1305_ietf_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_chacha20poly1305_ietf_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_chacha20poly1305_ietf_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_chacha20poly1305_ietf_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_chacha20poly1305_ietf_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): CryptoBox;
export function crypto_aead_chacha20poly1305_ietf_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): StringCryptoBox;

export function crypto_aead_chacha20poly1305_ietf_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_aead_chacha20poly1305_ietf_keygen(outputFormat: StringOutputFormat): string;

export function crypto_aead_chacha20poly1305_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_aead_chacha20poly1305_keygen(outputFormat: StringOutputFormat): string;

export function crypto_aead_xchacha20poly1305_ietf_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_xchacha20poly1305_ietf_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_xchacha20poly1305_ietf_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): CryptoBox;
export function crypto_aead_xchacha20poly1305_ietf_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): StringCryptoBox;

export function crypto_aead_xchacha20poly1305_ietf_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_aead_xchacha20poly1305_ietf_keygen(outputFormat: StringOutputFormat): string;

export function crypto_aead_aegis128l_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_aegis128l_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_aegis128l_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_aegis128l_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_aegis128l_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_aegis128l_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_aegis128l_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): CryptoBox;
export function crypto_aead_aegis128l_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): StringCryptoBox;

export function crypto_aead_aegis128l_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_aead_aegis128l_keygen(outputFormat: StringOutputFormat): string;

export function crypto_aead_aegis256_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_aead_aegis256_decrypt(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_aegis256_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;

export function crypto_aead_aegis256_decrypt_detached(
    secret_nonce: string | Uint8Array | null,
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    additional_data: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_aegis256_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;

export function crypto_aead_aegis256_encrypt(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_aead_aegis256_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): CryptoBox;

export function crypto_aead_aegis256_encrypt_detached(
    message: string | Uint8Array,
    additional_data: string | Uint8Array | null,
    secret_nonce: string | Uint8Array | null,
    public_nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): StringCryptoBox;

export function crypto_aead_aegis256_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_aead_aegis256_keygen(outputFormat: StringOutputFormat): string;

export function crypto_auth(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_auth(message: string | Uint8Array, key: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_auth_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_auth_keygen(outputFormat: StringOutputFormat): string;

export function crypto_auth_verify(tag: Uint8Array, message: string | Uint8Array, key: Uint8Array): boolean;

export function crypto_box_beforenm(
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_box_beforenm(
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_box_detached(
    message: string | Uint8Array,
    nonce: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): CryptoBox;
export function crypto_box_detached(
    message: string | Uint8Array,
    nonce: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat: StringOutputFormat,
): StringCryptoBox;

export function crypto_box_easy(
    message: string | Uint8Array,
    nonce: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_box_easy(
    message: string | Uint8Array,
    nonce: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_box_easy_afternm(
    message: string | Uint8Array,
    nonce: Uint8Array,
    sharedKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_box_easy_afternm(
    message: string | Uint8Array,
    nonce: Uint8Array,
    sharedKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_box_keypair(outputFormat?: Uint8ArrayOutputFormat | null): KeyPair;
export function crypto_box_keypair(outputFormat: StringOutputFormat): StringKeyPair;

export function crypto_box_open_detached(
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    nonce: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_box_open_detached(
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    nonce: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_box_open_easy(
    ciphertext: string | Uint8Array,
    nonce: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_box_open_easy(
    ciphertext: string | Uint8Array,
    nonce: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_box_open_easy_afternm(
    ciphertext: string | Uint8Array,
    nonce: Uint8Array,
    sharedKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_box_open_easy_afternm(
    ciphertext: string | Uint8Array,
    nonce: Uint8Array,
    sharedKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_box_seal(
    message: string | Uint8Array,
    publicKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_box_seal(
    message: string | Uint8Array,
    publicKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_box_seal_open(
    ciphertext: string | Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_box_seal_open(
    ciphertext: string | Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_box_seed_keypair(seed: Uint8Array, outputFormat?: Uint8ArrayOutputFormat | null): KeyPair;
export function crypto_box_seed_keypair(seed: Uint8Array, outputFormat: StringOutputFormat): StringKeyPair;

export function crypto_generichash(
    hash_length: number,
    message: string | Uint8Array,
    key?: string | Uint8Array | null,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_generichash(
    hash_length: number,
    message: string | Uint8Array,
    key: string | Uint8Array | null,
    outputFormat: StringOutputFormat,
): string;

export function crypto_generichash_final(
    state_address: StateAddress,
    hash_length: number,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_generichash_final(
    state_address: StateAddress,
    hash_length: number,
    outputFormat: StringOutputFormat,
): string;

export function crypto_generichash_init(key: string | Uint8Array | null, hash_length: number): StateAddress;

export function crypto_generichash_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_generichash_keygen(outputFormat: StringOutputFormat): string;

export function crypto_generichash_update(state_address: StateAddress, message_chunk: string | Uint8Array): void;

export function crypto_hash(message: string | Uint8Array, outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_hash(message: string | Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_kdf_derive_from_key(
    subkey_len: number,
    subkey_id: number,
    ctx: string,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_kdf_derive_from_key(
    subkey_len: number,
    subkey_id: number,
    ctx: string,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_kdf_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_kdf_keygen(outputFormat: StringOutputFormat): string;

export function crypto_kx_client_session_keys(
    clientPublicKey: Uint8Array,
    clientSecretKey: Uint8Array,
    serverPublicKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): CryptoKX;
export function crypto_kx_client_session_keys(
    clientPublicKey: Uint8Array,
    clientSecretKey: Uint8Array,
    serverPublicKey: Uint8Array,
    outputFormat: StringOutputFormat,
): StringCryptoKX;

export function crypto_kx_keypair(outputFormat?: Uint8ArrayOutputFormat | null): KeyPair;
export function crypto_kx_keypair(outputFormat: StringOutputFormat): StringKeyPair;

export function crypto_kx_seed_keypair(seed: Uint8Array, outputFormat?: Uint8ArrayOutputFormat | null): KeyPair;
export function crypto_kx_seed_keypair(seed: Uint8Array, outputFormat: StringOutputFormat): StringKeyPair;

export function crypto_kx_server_session_keys(
    serverPublicKey: Uint8Array,
    serverSecretKey: Uint8Array,
    clientPublicKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): CryptoKX;
export function crypto_kx_server_session_keys(
    serverPublicKey: Uint8Array,
    serverSecretKey: Uint8Array,
    clientPublicKey: Uint8Array,
    outputFormat: StringOutputFormat,
): StringCryptoKX;

export function crypto_pwhash(
    keyLength: number,
    password: string | Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_pwhash(
    keyLength: number,
    password: string | Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
    outputFormat: StringOutputFormat,
): string;

export function crypto_pwhash_str(password: string | Uint8Array, opsLimit: number, memLimit: number): string;

export function crypto_pwhash_str_verify(hashed_password: string, password: string | Uint8Array): boolean;

export function crypto_pwhash_str_needs_rehash(hashedPassword: string, opsLimit: number, memLimit: number): boolean;

export function crypto_scalarmult(
    privateKey: Uint8Array,
    publicKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_scalarmult(
    privateKey: Uint8Array,
    publicKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_scalarmult_base(
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_scalarmult_base(privateKey: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_secretbox_detached(
    message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): SecretBox;
export function crypto_secretbox_detached(
    message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): StringSecretBox;

export function crypto_secretbox_easy(
    message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_secretbox_easy(
    message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_secretbox_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_secretbox_keygen(outputFormat: StringOutputFormat): string;

export function crypto_secretbox_open_detached(
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_secretbox_open_detached(
    ciphertext: string | Uint8Array,
    mac: Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_secretbox_open_easy(
    ciphertext: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_secretbox_open_easy(
    ciphertext: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_secretstream_xchacha20poly1305_init_pull(header: Uint8Array, key: Uint8Array): StateAddress;

export function crypto_secretstream_xchacha20poly1305_init_push(
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): { state: StateAddress; header: Uint8Array };
export function crypto_secretstream_xchacha20poly1305_init_push(
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): { state: StateAddress; header: string };

export function crypto_secretstream_xchacha20poly1305_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_secretstream_xchacha20poly1305_keygen(outputFormat: StringOutputFormat): string;

export function crypto_secretstream_xchacha20poly1305_pull(
    state_address: StateAddress,
    cipher: string | Uint8Array,
    ad?: string | Uint8Array | null,
    outputFormat?: Uint8ArrayOutputFormat | null,
): MessageTag;
export function crypto_secretstream_xchacha20poly1305_pull(
    state_address: StateAddress,
    cipher: string | Uint8Array,
    ad: string | Uint8Array | null,
    outputFormat: StringOutputFormat,
): StringMessageTag;

export function crypto_secretstream_xchacha20poly1305_push(
    state_address: StateAddress,
    message_chunk: string | Uint8Array,
    ad: string | Uint8Array | null,
    tag: number,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_secretstream_xchacha20poly1305_push(
    state_address: StateAddress,
    message_chunk: string | Uint8Array,
    ad: string | Uint8Array | null,
    tag: number,
    outputFormat: StringOutputFormat,
): string;

export function crypto_secretstream_xchacha20poly1305_rekey(state_address: StateAddress): true;

export function crypto_shorthash(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_shorthash(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_shorthash_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_shorthash_keygen(outputFormat: StringOutputFormat): string;

export function crypto_sign(
    message: string | Uint8Array,
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_sign(
    message: string | Uint8Array,
    privateKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_sign_detached(
    message: string | Uint8Array,
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_sign_detached(
    message: string | Uint8Array,
    privateKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_sign_ed25519_pk_to_curve25519(
    edPk: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_sign_ed25519_pk_to_curve25519(edPk: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_sign_ed25519_sk_to_curve25519(
    edSk: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_sign_ed25519_sk_to_curve25519(edSk: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_sign_final_create(
    state_address: StateAddress,
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_sign_final_create(
    state_address: StateAddress,
    privateKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_sign_final_verify(
    state_address: StateAddress,
    signature: Uint8Array,
    publicKey: Uint8Array,
): boolean;

export function crypto_sign_init(): StateAddress;

export function crypto_sign_keypair(outputFormat?: Uint8ArrayOutputFormat | null): KeyPair;
export function crypto_sign_keypair(outputFormat: StringOutputFormat): StringKeyPair;

export function crypto_sign_open(
    signedMessage: string | Uint8Array,
    publicKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_sign_open(
    signedMessage: string | Uint8Array,
    publicKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_sign_seed_keypair(seed: Uint8Array, outputFormat?: Uint8ArrayOutputFormat | null): KeyPair;
export function crypto_sign_seed_keypair(seed: Uint8Array, outputFormat: StringOutputFormat): StringKeyPair;

export function crypto_sign_update(state_address: StateAddress, message_chunk: string | Uint8Array): void;

export function crypto_sign_verify_detached(
    signature: Uint8Array,
    message: string | Uint8Array,
    publicKey: Uint8Array,
): boolean;

export function from_base64(input: string, variant?: base64_variants): Uint8Array;

export function from_hex(input: string): Uint8Array;

export function from_string(str: string): Uint8Array;

export function increment(bytes: Uint8Array): void;

export function is_zero(bytes: Uint8Array): boolean;

export function memcmp(b1: Uint8Array, b2: Uint8Array): boolean;

export function memzero(bytes: Uint8Array): void;

export function output_formats(): Array<Uint8ArrayOutputFormat | StringOutputFormat>;

export function pad(buf: Uint8Array, blocksize: number): Uint8Array;

export function randombytes_buf(length: number, outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function randombytes_buf(length: number, outputFormat: StringOutputFormat): string;

export function randombytes_buf_deterministic(
    length: number,
    seed: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function randombytes_buf_deterministic(
    length: number,
    seed: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function randombytes_close(): void;

export function randombytes_random(): number;

export function randombytes_stir(): void;

export function randombytes_uniform(upper_bound: number): number;

export function sodium_version_string(): string;

export function symbols(): string[];

export function to_base64(input: string | Uint8Array, variant?: base64_variants): string;

export function to_hex(input: string | Uint8Array): string;

export function to_string(bytes: Uint8Array): string;

export function unpad(buf: Uint8Array, blocksize: number): Uint8Array;

// ---- sumo-only additions (@types/libsodium-wrappers-sumo@0.7.8) ----


export const crypto_auth_hmacsha256_BYTES: number;
export const crypto_auth_hmacsha256_KEYBYTES: number;
export const crypto_auth_hmacsha512_BYTES: number;
export const crypto_auth_hmacsha512_KEYBYTES: number;
export const crypto_auth_hmacsha512256_BYTES: number;
export const crypto_auth_hmacsha512256_KEYBYTES: number;
export const crypto_box_curve25519xchacha20poly1305_BEFORENMBYTES: number;
export const crypto_box_curve25519xchacha20poly1305_MACBYTES: number;
export const crypto_box_curve25519xchacha20poly1305_MESSAGEBYTES_MAX: number;
export const crypto_box_curve25519xchacha20poly1305_NONCEBYTES: number;
export const crypto_box_curve25519xchacha20poly1305_PUBLICKEYBYTES: number;
export const crypto_box_curve25519xchacha20poly1305_SEALBYTES: number;
export const crypto_box_curve25519xchacha20poly1305_SECRETKEYBYTES: number;
export const crypto_box_curve25519xchacha20poly1305_SEEDBYTES: number;
export const crypto_box_curve25519xsalsa20poly1305_BEFORENMBYTES: number;
export const crypto_box_curve25519xsalsa20poly1305_MACBYTES: number;
export const crypto_box_curve25519xsalsa20poly1305_MESSAGEBYTES_MAX: number;
export const crypto_box_curve25519xsalsa20poly1305_NONCEBYTES: number;
export const crypto_box_curve25519xsalsa20poly1305_PUBLICKEYBYTES: number;
export const crypto_box_curve25519xsalsa20poly1305_SECRETKEYBYTES: number;
export const crypto_box_curve25519xsalsa20poly1305_SEEDBYTES: number;
export const crypto_core_ed25519_BYTES: number;
export const crypto_core_ed25519_HASHBYTES: number;
export const crypto_core_ed25519_NONREDUCEDSCALARBYTES: number;
export const crypto_core_ed25519_SCALARBYTES: number;
export const crypto_core_ed25519_UNIFORMBYTES: number;
export const crypto_core_hchacha20_CONSTBYTES: number;
export const crypto_core_hchacha20_INPUTBYTES: number;
export const crypto_core_hchacha20_KEYBYTES: number;
export const crypto_core_hchacha20_OUTPUTBYTES: number;
export const crypto_core_hsalsa20_CONSTBYTES: number;
export const crypto_core_hsalsa20_INPUTBYTES: number;
export const crypto_core_hsalsa20_KEYBYTES: number;
export const crypto_core_hsalsa20_OUTPUTBYTES: number;
export const crypto_core_ristretto255_BYTES: number;
export const crypto_core_ristretto255_HASHBYTES: number;
export const crypto_core_ristretto255_NONREDUCEDSCALARBYTES: number;
export const crypto_core_ristretto255_SCALARBYTES: number;
export const crypto_core_salsa20_CONSTBYTES: number;
export const crypto_core_salsa20_INPUTBYTES: number;
export const crypto_core_salsa20_KEYBYTES: number;
export const crypto_core_salsa20_OUTPUTBYTES: number;
export const crypto_core_salsa2012_CONSTBYTES: number;
export const crypto_core_salsa2012_INPUTBYTES: number;
export const crypto_core_salsa2012_KEYBYTES: number;
export const crypto_core_salsa2012_OUTPUTBYTES: number;
export const crypto_generichash_blake2b_BYTES: number;
export const crypto_generichash_blake2b_BYTES_MAX: number;
export const crypto_generichash_blake2b_BYTES_MIN: number;
export const crypto_generichash_blake2b_KEYBYTES: number;
export const crypto_generichash_blake2b_KEYBYTES_MAX: number;
export const crypto_generichash_blake2b_KEYBYTES_MIN: number;
export const crypto_generichash_blake2b_PERSONALBYTES: number;
export const crypto_generichash_blake2b_SALTBYTES: number;
export const crypto_hash_sha256_BYTES: number;
export const crypto_hash_sha512_BYTES: number;
export const crypto_kdf_blake2b_BYTES_MAX: number;
export const crypto_kdf_blake2b_BYTES_MIN: number;
export const crypto_kdf_blake2b_CONTEXTBYTES: number;
export const crypto_kdf_blake2b_KEYBYTES: number;
export const crypto_onetimeauth_BYTES: number;
export const crypto_onetimeauth_KEYBYTES: number;
export const crypto_onetimeauth_poly1305_BYTES: number;
export const crypto_onetimeauth_poly1305_KEYBYTES: number;
export const crypto_pwhash_argon2i_BYTES_MAX: number;
export const crypto_pwhash_argon2i_BYTES_MIN: number;
export const crypto_pwhash_argon2i_SALTBYTES: number;
export const crypto_pwhash_argon2i_STRBYTES: number;
export const crypto_pwhash_argon2id_BYTES_MAX: number;
export const crypto_pwhash_argon2id_BYTES_MIN: number;
export const crypto_pwhash_argon2id_SALTBYTES: number;
export const crypto_pwhash_argon2id_STRBYTES: number;
export const crypto_pwhash_scryptsalsa208sha256_BYTES_MAX: number;
export const crypto_pwhash_scryptsalsa208sha256_BYTES_MIN: number;
export const crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_INTERACTIVE: number;
export const crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_MAX: number;
export const crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_MIN: number;
export const crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_SENSITIVE: number;
export const crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_INTERACTIVE: number;
export const crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_MAX: number;
export const crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_MIN: number;
export const crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_SENSITIVE: number;
export const crypto_pwhash_scryptsalsa208sha256_SALTBYTES: number;
export const crypto_pwhash_scryptsalsa208sha256_STRBYTES: number;
export const crypto_pwhash_scryptsalsa208sha256_STRPREFIX: string;
export const crypto_scalarmult_curve25519_BYTES: number;
export const crypto_scalarmult_curve25519_SCALARBYTES: number;
export const crypto_scalarmult_ed25519_BYTES: number;
export const crypto_scalarmult_ed25519_SCALARBYTES: number;
export const crypto_scalarmult_ristretto255_BYTES: number;
export const crypto_scalarmult_ristretto255_SCALARBYTES: number;
export const crypto_secretbox_xchacha20poly1305_KEYBYTES: number;
export const crypto_secretbox_xchacha20poly1305_MACBYTES: number;
export const crypto_secretbox_xchacha20poly1305_MESSAGEBYTES_MAX: number;
export const crypto_secretbox_xchacha20poly1305_NONCEBYTES: number;
export const crypto_secretbox_xsalsa20poly1305_KEYBYTES: number;
export const crypto_secretbox_xsalsa20poly1305_MACBYTES: number;
export const crypto_secretbox_xsalsa20poly1305_MESSAGEBYTES_MAX: number;
export const crypto_secretbox_xsalsa20poly1305_NONCEBYTES: number;
export const crypto_shorthash_siphash24_BYTES: number;
export const crypto_shorthash_siphash24_KEYBYTES: number;
export const crypto_shorthash_siphashx24_BYTES: number;
export const crypto_shorthash_siphashx24_KEYBYTES: number;
export const crypto_sign_ed25519_BYTES: number;
export const crypto_sign_ed25519_MESSAGEBYTES_MAX: number;
export const crypto_sign_ed25519_PUBLICKEYBYTES: number;
export const crypto_sign_ed25519_SECRETKEYBYTES: number;
export const crypto_sign_ed25519_SEEDBYTES: number;
export const crypto_stream_chacha20_ietf_KEYBYTES: number;
export const crypto_stream_chacha20_IETF_KEYBYTES: number;
export const crypto_stream_chacha20_ietf_MESSAGEBYTES_MAX: number;
export const crypto_stream_chacha20_IETF_MESSAGEBYTES_MAX: number;
export const crypto_stream_chacha20_ietf_NONCEBYTES: number;
export const crypto_stream_chacha20_IETF_NONCEBYTES: number;
export const crypto_stream_chacha20_KEYBYTES: number;
export const crypto_stream_chacha20_MESSAGEBYTES_MAX: number;
export const crypto_stream_chacha20_NONCEBYTES: number;
export const crypto_stream_KEYBYTES: number;
export const crypto_stream_MESSAGEBYTES_MAX: number;
export const crypto_stream_NONCEBYTES: number;
export const crypto_stream_salsa20_KEYBYTES: number;
export const crypto_stream_salsa20_MESSAGEBYTES_MAX: number;
export const crypto_stream_salsa20_NONCEBYTES: number;
export const crypto_stream_salsa2012_KEYBYTES: number;
export const crypto_stream_salsa2012_MESSAGEBYTES_MAX: number;
export const crypto_stream_salsa2012_NONCEBYTES: number;
export const crypto_stream_salsa208_KEYBYTES: number;
export const crypto_stream_salsa208_MESSAGEBYTES_MAX: number;
export const crypto_stream_salsa208_NONCEBYTES: number;
export const crypto_stream_xchacha20_KEYBYTES: number;
export const crypto_stream_xchacha20_MESSAGEBYTES_MAX: number;
export const crypto_stream_xchacha20_NONCEBYTES: number;
export const crypto_stream_xsalsa20_KEYBYTES: number;
export const crypto_stream_xsalsa20_MESSAGEBYTES_MAX: number;
export const crypto_stream_xsalsa20_NONCEBYTES: number;
export const crypto_verify_16_BYTES: number;
export const crypto_verify_32_BYTES: number;
export const crypto_verify_64_BYTES: number;

export function crypto_auth_hmacsha256(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_auth_hmacsha256(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_auth_hmacsha256_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_auth_hmacsha256_keygen(outputFormat: StringOutputFormat): string;

export function crypto_auth_hmacsha256_verify(tag: Uint8Array, message: string | Uint8Array, key: Uint8Array): boolean;

export function crypto_auth_hmacsha512(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_auth_hmacsha512(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_auth_hmacsha512_keygen(outputFormat: StringOutputFormat): string;
export function crypto_auth_hmacsha512_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;

export function crypto_auth_hmacsha512_verify(tag: Uint8Array, message: string | Uint8Array, key: Uint8Array): boolean;

export function crypto_box_curve25519xchacha20poly1305_keypair(
    publicKey: Uint8Array,
    secretKey: Uint8Array,
    outputFormat: StringOutputFormat,
): StringKeyPair;
export function crypto_box_curve25519xchacha20poly1305_keypair(
    publicKey: Uint8Array,
    secretKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): KeyPair;

export function crypto_box_curve25519xchacha20poly1305_seal(
    message: Uint8Array,
    publicKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;
export function crypto_box_curve25519xchacha20poly1305_seal(
    message: Uint8Array,
    publicKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;

export function crypto_box_curve25519xchacha20poly1305_seal_open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    secretKey: Uint8Array,
    outputFormat: StringOutputFormat,
): string;
export function crypto_box_curve25519xchacha20poly1305_seal_open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    secretKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;

export function crypto_core_ristretto255_add(
    p: Uint8Array,
    q: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_add(p: Uint8Array, q: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ristretto255_from_hash(
    r: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_from_hash(r: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ristretto255_is_valid_point(point: string | Uint8Array): boolean;

export function crypto_core_ristretto255_random(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_core_ristretto255_random(outputFormat: StringOutputFormat): string;

export function crypto_core_ristretto255_scalar_add(
    x: Uint8Array,
    y: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_scalar_add(
    x: Uint8Array,
    y: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_core_ristretto255_scalar_complement(
    scalar: string | Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_scalar_complement(
    scalar: string | Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_core_ristretto255_scalar_invert(
    scalar: string | Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_scalar_invert(
    scalar: string | Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_core_ristretto255_scalar_mul(
    x: Uint8Array,
    y: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_scalar_mul(
    x: Uint8Array,
    y: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_core_ristretto255_scalar_negate(
    scalar: string | Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_scalar_negate(
    scalar: string | Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_core_ristretto255_scalar_random(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_core_ristretto255_scalar_random(outputFormat: StringOutputFormat): string;

export function crypto_core_ristretto255_scalar_reduce(
    secret: string | Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_scalar_reduce(
    secret: string | Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_core_ristretto255_scalar_sub(
    x: Uint8Array,
    y: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_scalar_sub(
    x: Uint8Array,
    y: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_core_ristretto255_sub(
    p: Uint8Array,
    q: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ristretto255_sub(p: Uint8Array, q: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_generichash_blake2b_salt_personal(
    subkey_len: number,
    key: string | Uint8Array | null,
    id: Uint8Array,
    ctx: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_generichash_blake2b_salt_personal(
    subkey_len: number,
    key: string | Uint8Array | null,
    id: Uint8Array,
    ctx: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_hash_sha256(
    message: string | Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_hash_sha256(message: string | Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_hash_sha256_final(
    stateAddress: StateAddress,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_hash_sha256_final(stateAddress: StateAddress, outputFormat: StringOutputFormat | null): string;

export function crypto_hash_sha256_init(): number;
export function crypto_hash_sha256_update(stateAddress: StateAddress, message: Uint8Array): void;

export function crypto_hash_sha512(
    message: string | Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_hash_sha512(message: string | Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_hash_sha512_final(
    stateAddress: StateAddress,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_hash_sha512_final(stateAddress: StateAddress, outputFormat: StringOutputFormat | null): string;

export function crypto_hash_sha512_init(): number;
export function crypto_hash_sha512_update(stateAddress: StateAddress, message: Uint8Array): void;

export function crypto_onetimeauth(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_onetimeauth(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_onetimeauth_final(
    stateAddress: StateAddress,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_onetimeauth_final(stateAddress: StateAddress, outputFormat: StringOutputFormat): string;

export function crypto_onetimeauth_init(key?: string | Uint8Array | null): StateAddress;

export function crypto_onetimeauth_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_onetimeauth_keygen(outputFormat: StringOutputFormat): string;

export function crypto_onetimeauth_update(stateAddress: StateAddress, message_chunk: string | Uint8Array): void;

export function crypto_onetimeauth_verify(hash: Uint8Array, message: string | Uint8Array, key: Uint8Array): boolean;

export function crypto_pwhash_scryptsalsa208sha256(
    keyLength: number,
    password: string | Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_pwhash_scryptsalsa208sha256(
    keyLength: number,
    password: string | Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    outputFormat: StringOutputFormat,
): string;

export function crypto_pwhash_scryptsalsa208sha256_ll(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    opsLimit: number,
    r: number,
    p: number,
    keyLength: number,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_pwhash_scryptsalsa208sha256_ll(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    opsLimit: number,
    r: number,
    p: number,
    keyLength: number,
    outputFormat: StringOutputFormat,
): string;

export function crypto_core_ed25519_add(
    p: Uint8Array,
    q: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_add(p: Uint8Array, q: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_from_hash(
    r: string | Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_from_hash(r: string | Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_from_uniform(
    r: string | Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_from_uniform(r: string | Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_is_valid_point(repr: Uint8Array): boolean;

export function crypto_core_ed25519_random(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_core_ed25519_random(outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_scalar_add(
    x: Uint8Array,
    y: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_scalar_add(x: Uint8Array, y: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_scalar_complement(
    s: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_scalar_complement(s: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_scalar_invert(
    s: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_scalar_invert(s: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_scalar_mul(
    x: Uint8Array,
    y: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_scalar_mul(x: Uint8Array, y: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_scalar_negate(
    s: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_scalar_negate(s: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_scalar_random(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_core_ed25519_scalar_random(outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_scalar_reduce(
    sample: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_scalar_reduce(sample: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_scalar_sub(
    x: Uint8Array,
    y: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_scalar_sub(x: Uint8Array, y: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_core_ed25519_sub(
    p: Uint8Array,
    q: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_core_ed25519_sub(p: Uint8Array, q: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_pwhash_scryptsalsa208sha256_str(
    password: string | Uint8Array,
    opsLimit: number,
    memLimit: number,
): string;

export function crypto_pwhash_scryptsalsa208sha256_str_verify(
    hashed_password: string,
    password: string | Uint8Array,
): boolean;

export function crypto_scalarmult_ed25519(
    n: Uint8Array,
    p: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_scalarmult_ed25519(n: Uint8Array, p: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_scalarmult_ed25519_base(
    scalar: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_scalarmult_ed25519_base(scalar: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_scalarmult_ed25519_base_noclamp(
    scalar: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_scalarmult_ed25519_base_noclamp(scalar: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_scalarmult_ed25519_noclamp(
    n: Uint8Array,
    p: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_scalarmult_ed25519_noclamp(
    n: Uint8Array,
    p: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_scalarmult_ristretto255(
    scalar: Uint8Array,
    element: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_scalarmult_ristretto255(
    scalar: Uint8Array,
    element: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_scalarmult_ristretto255_base(
    scalar: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_scalarmult_ristretto255_base(scalar: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_shorthash_siphashx24(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_shorthash_siphashx24(
    message: string | Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_sign_ed25519_sk_to_pk(
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_sign_ed25519_sk_to_pk(privateKey: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_sign_ed25519_sk_to_seed(
    privateKey: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_sign_ed25519_sk_to_seed(privateKey: Uint8Array, outputFormat: StringOutputFormat): string;

export function crypto_stream_chacha20(
    outLength: number,
    key: Uint8Array,
    nonce: Uint8Array,
    outputFormat: StringOutputFormat,
): string;
export function crypto_stream_chacha20(
    outLength: number,
    key: Uint8Array,
    nonce: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;

export function crypto_stream_chacha20_ietf_xor(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_stream_chacha20_ietf_xor(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_stream_chacha20_ietf_xor_ic(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    nonce_increment: number,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_stream_chacha20_ietf_xor_ic(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    nonce_increment: number,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_stream_chacha20_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_stream_chacha20_keygen(outputFormat: StringOutputFormat): string;

export function crypto_stream_chacha20_xor(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_stream_chacha20_xor(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_stream_chacha20_xor_ic(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    nonce_increment: number,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_stream_chacha20_xor_ic(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    nonce_increment: number,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_stream_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_stream_keygen(outputFormat: StringOutputFormat): string;

export function crypto_stream_xchacha20_keygen(outputFormat?: Uint8ArrayOutputFormat | null): Uint8Array;
export function crypto_stream_xchacha20_keygen(outputFormat: StringOutputFormat): string;

export function crypto_stream_xchacha20_xor(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_stream_xchacha20_xor(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;

export function crypto_stream_xchacha20_xor_ic(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    nonce_increment: number,
    key: Uint8Array,
    outputFormat?: Uint8ArrayOutputFormat | null,
): Uint8Array;
export function crypto_stream_xchacha20_xor_ic(
    input_message: string | Uint8Array,
    nonce: Uint8Array,
    nonce_increment: number,
    key: Uint8Array,
    outputFormat: StringOutputFormat,
): string;
