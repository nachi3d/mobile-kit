import readline from 'node:readline';

/** Asks a yes/no question; anything but y/yes (or no input at all) is no. */
export async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const answer = await new Promise<string>((resolve) => {
    let done = false;
    rl.once('line', (line) => {
      done = true;
      resolve(line);
    });
    rl.once('close', () => {
      if (!done) resolve('');
    });
  });
  rl.close();
  if (!process.stdin.isTTY) process.stdout.write('\n');
  return /^(y|yes)$/i.test(answer.trim());
}
