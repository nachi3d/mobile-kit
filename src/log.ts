/** A stop with a message for the user (no stack trace). */
export class KitError extends Error {
  override name = 'KitError';
}

export function fail(message: string): never {
  throw new KitError(message);
}

export function info(message: string): void {
  console.log(`==> ${message}`);
}

export function detail(message: string): void {
  console.log(`    ${message}`);
}

export function warn(message: string): void {
  console.error(`WARNING: ${message}`);
}
