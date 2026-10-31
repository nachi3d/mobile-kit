// Why a Gradle build failed, read from its output, so the message names the
// probable cause instead of guessing "out of memory" (on 2026-10-23 it was a
// JRE without javac).

export type GradleFailureKind = 'no-javac' | 'jdk-version' | 'out-of-memory' | 'other';

export interface GradleFailure {
  kind: GradleFailureKind;
  /** One or two sentences for the user: the cause and what to do. */
  cause: string;
  /** The output line that gave it away, when there is one. */
  evidence?: string;
}

const NO_JAVAC = [
  /does not provide the required capabilities: \[JAVA_COMPILER\]/i,
  /No Java compiler found/i,
  /Unable to find a javac compiler/i,
  /Could not find tools\.jar/i,
  /javac(\.exe)?['"]? (is not recognized|not found|: not found)/i,
  /Cannot find a Java installation .* matching: .*JAVA_COMPILER/i,
];

const JDK_VERSION = [
  /Unsupported class file major version \d+/i,
  /requires Java \d+ to run\. You are currently using Java \d+/i,
  /Android Gradle plugin requires Java \d+/i,
  /Unsupported Java\. *Your build is currently configured to use Java \d+/i,
  /error: invalid (source|target) release: \d+/i,
  /Could not determine java version from/i,
  /Dependency requires at least JVM runtime version \d+/i,
];

const OUT_OF_MEMORY = [
  /java\.lang\.OutOfMemoryError: (Java heap space|Metaspace|GC overhead limit exceeded)/i,
  /OutOfMemoryError/,
  /Expiring Daemon because JVM heap space is exhausted/i,
  /There is insufficient memory for the Java Runtime Environment/i,
  /Native memory allocation \(m(map|alloc)\) failed/i,
  /The paging file is too small/i,
  /Gradle build daemon disappeared unexpectedly/i,
];

function firstMatch(lines: string[], patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const line = lines.find((l) => p.test(l));
    if (line) return line.trim();
  }
  return undefined;
}

/** The first lines of Gradle's "* What went wrong:" block, or ''. */
export function whatWentWrong(output: string): string {
  const m = /\* What went wrong:\s*\n([\s\S]*?)(?:\n\s*\n|\n\* Try:|$)/.exec(output.replace(/\r/g, ''));
  return (m?.[1] ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' ');
}

/** The probable cause of a failed Gradle run, from its output (stdout + stderr). */
export function gradleFailure(output: string): GradleFailure {
  const lines = output.replace(/\r/g, '').split('\n');
  let evidence = firstMatch(lines, NO_JAVAC);
  if (evidence) {
    return {
      kind: 'no-javac',
      evidence,
      cause: 'Gradle found no Java compiler: JAVA_HOME is probably a JRE, not a JDK. Point JAVA_HOME at a JDK 17 (mk build --local --dry-run checks it).',
    };
  }
  evidence = firstMatch(lines, JDK_VERSION);
  if (evidence) {
    return {
      kind: 'jdk-version',
      evidence,
      cause: 'Gradle ran with the wrong Java version. Point JAVA_HOME at a JDK 17 (mk build --local --dry-run checks it).',
    };
  }
  evidence = firstMatch(lines, OUT_OF_MEMORY);
  if (evidence) {
    const metaspace = /Metaspace/i.test(evidence);
    return {
      kind: 'out-of-memory',
      evidence,
      cause: metaspace
        ? 'Gradle ran out of Metaspace (class memory). Close other Java programs (Android Studio, a running emulator) and retry.'
        : 'Gradle ran out of memory. Close Brave and other browsers, Android Studio and a running emulator, then retry.',
    };
  }
  const wrong = whatWentWrong(output);
  return {
    kind: 'other',
    ...(wrong ? { evidence: wrong } : {}),
    cause: wrong
      ? `Gradle says: ${wrong}`
      : 'Gradle stopped without saying why (no "What went wrong" in its output): scroll up for the first error.',
  };
}
