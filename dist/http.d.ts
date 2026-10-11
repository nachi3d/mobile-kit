export interface Head {
    status: string;
    header(name: string): string;
}
/** HEAD request through curl; the last value of each header wins. */
export declare function httpHead(curl: string[], url: string): Head;
/** Same, past the CDN cache: a unique query string makes the edge ask the origin. */
export declare const originHead: (curl: string[], url: string) => Head;
