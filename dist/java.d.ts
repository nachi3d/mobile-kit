export declare const REQUIRED_JDK = 17;
export interface JdkInfo {
    home: string;
    /** bin/javac(.exe), or null: a JRE (or not a Java at all). */
    javac: string | null;
    /** Major version (17, 21, 8…), or null when it cannot be read. */
    major: number | null;
    /** The full version string, e.g. "17.0.18". */
    version: string | null;
}
/** "17.0.18" → 17, "1.8.0_392" → 8. */
export declare function javaMajor(version: string): number | null;
/** The JDK (or JRE) at `home`: its `release` file, else `javac -version`. */
export declare function readJdk(home: string): JdkInfo;
/** JDKs of the required version installed in the usual places (for the setx hint). */
export declare function findJdkCandidates(env?: NodeJS.ProcessEnv): string[];
/** How to point JAVA_HOME at `home` for good (a new terminal picks it up). */
export declare function setJavaHomeHint(home: string | undefined, platform?: NodeJS.Platform): string;
/**
 * Why JAVA_HOME cannot build Android (with the fix), or null when it is a
 * JDK REQUIRED_JDK.
 */
export declare function jdkProblem(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | null;
