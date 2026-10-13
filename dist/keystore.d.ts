import { type Project } from './project.js';
export declare const KEYSTORE_PULL_USAGE = "Usage: mk keystore:pull [--dry-run]";
export interface Signing {
    dir: string;
    storeFile: string;
    storePassword: string;
    keyAlias: string;
    keyPassword: string;
}
/** MK_KEYSTORE_DIR from the environment, else from .env.local; a stop when neither has it. */
export declare function keystoreDir(root: string): string;
/** The keystore folder is never inside a repository: a `git add .` would publish the key. */
export declare function requireOutsideRepos(dir: string): void;
/** The key's certificate SHA-1, read by keytool (the password goes through its environment). */
export declare function keystoreSha1(p: Project, s: Pick<Signing, 'storeFile' | 'storePassword' | 'keyAlias'>): string;
/**
 * The production key, checked: files present, and its certificate is the
 * one mobile-kit.config.json names (the key every published APK carries).
 * Read-only, so a dry run checks it too.
 */
export declare function loadSigning(p: Project): Signing;
/**
 * mk keystore:pull — run by hand, once per computer. `eas credentials`
 * (interactive) downloads the production keystore and its passwords into
 * the app folder (credentials.json + credentials/android/keystore.jks, both
 * gitignored); mk moves them at once to MK_KEYSTORE_DIR, outside every
 * repository, and checks the certificate against mobile-kit.config.json.
 */
export declare function keystorePull(args: string[]): Promise<void>;
