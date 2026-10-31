export type GradleFailureKind = 'no-javac' | 'jdk-version' | 'out-of-memory' | 'other';
export interface GradleFailure {
    kind: GradleFailureKind;
    /** One or two sentences for the user: the cause and what to do. */
    cause: string;
    /** The output line that gave it away, when there is one. */
    evidence?: string;
}
/** The first lines of Gradle's "* What went wrong:" block, or ''. */
export declare function whatWentWrong(output: string): string;
/** The probable cause of a failed Gradle run, from its output (stdout + stderr). */
export declare function gradleFailure(output: string): GradleFailure;
