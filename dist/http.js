import { run } from './exec.js';
/** HEAD request through curl; the last value of each header wins. */
export function httpHead(curl, url) {
    const r = run(curl, ['-sI', url]);
    const lines = r.status === 0 ? r.stdout.split('\n') : [];
    const status = lines[0]?.split(' ')[1] ?? '';
    return {
        status,
        header(name) {
            const prefix = `${name.toLowerCase()}:`;
            const found = lines.filter((l) => l.toLowerCase().startsWith(prefix));
            return found.length ? (found[found.length - 1] ?? '').slice(prefix.length).trim() : '';
        },
    };
}
/** Same, past the CDN cache: a unique query string makes the edge ask the origin. */
export const originHead = (curl, url) => httpHead(curl, `${url}?release-check=${Date.now()}${Math.floor(Math.random() * 1e6)}`);
