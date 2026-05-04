
export const getBackoffDelay = (a: number) => Math.min(1000 * 2 ** a, 5000);
