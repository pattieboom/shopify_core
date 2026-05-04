
export type ShopifyGraphQLRequest = {
  shop: string;
  accessToken: string;
  query: string;
  variables?: any;
};
