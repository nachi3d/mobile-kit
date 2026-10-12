/** A stop with a message for the user (no stack trace). */
export class KitError extends Error {
    name = 'KitError';
}
export function fail(message) {
    throw new KitError(message);
}
export function info(message) {
    console.log(`==> ${message}`);
}
export function detail(message) {
    console.log(`    ${message}`);
}
export function warn(message) {
    console.error(`WARNING: ${message}`);
}
