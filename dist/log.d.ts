/** A stop with a message for the user (no stack trace). */
export declare class KitError extends Error {
    name: string;
}
export declare function fail(message: string): never;
export declare function info(message: string): void;
export declare function detail(message: string): void;
export declare function warn(message: string): void;
