type ShopifyGraphQLRequest = {
    shop: string;
    accessToken: string;
    query: string;
    variables?: any;
};

declare function createShopifyClient(env: any, app: string): {
    graphql({ shop, accessToken, query, variables }: ShopifyGraphQLRequest): Promise<any>;
};

type Job = {
    resolve: (v: Response) => void;
    reject: (e: Response) => void;
    payload: any;
};
declare class ShopifyRateLimiterDO {
    queue: Job[];
    running: boolean;
    currentlyAvailable: number;
    restoreRate: number;
    fetch(req: Request): Promise<Response>;
    run(): Promise<void>;
    handle(payload: any): Promise<any>;
    backfill(payload: any): Promise<{
        orders: any[];
        nextCursor: any;
        hasNextPage: any;
    }>;
}

type BulkRunOptions = {
    shop: string;
    accessToken: string;
    query: string;
    onOrder: (order: any) => Promise<void>;
    signal?: AbortSignal;
};
declare function runBulk({ shop, accessToken, query, onOrder, signal }: BulkRunOptions): Promise<void>;

export { ShopifyRateLimiterDO, createShopifyClient, runBulk };
