import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// ---------------------------------------------------------------------------
// GraphQL types (minimal — only the fields we use)
// ---------------------------------------------------------------------------

interface VariantNode {
  id: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryPolicy: string;
  sku: string | null;
}

interface ProductNode {
  id: string;
  title: string;
  status: string;
  variants: {
    edges: Array<{ node: VariantNode }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

interface ProductsResponse {
  data: {
    products: {
      edges: Array<{ node: ProductNode }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Shopify variant limit: a product can have at most 100 variants.
// We flag products approaching this ceiling so the UI can warn the merchant.
// ---------------------------------------------------------------------------
const SHOPIFY_VARIANT_MAX = 100;
const VARIANT_LIMIT_WARNING_THRESHOLD = 15;

const PRODUCTS_QUERY = `#graphql
  query GetActiveProducts($cursor: String) {
    products(first: 50, after: $cursor, query: "status:active") {
      edges {
        node {
          id
          title
          status
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                inventoryQuantity
                inventoryPolicy
                sku
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const products: Array<{
    id: string;
    title: string;
    status: string;
    variantLimitExceeded: boolean;
    maxAdditionalVariants: number;
    variants: Array<{
      id: string;
      title: string;
      price: string;
      compareAtPrice: string | null;
      inventoryQuantity: number | null;
      inventoryPolicy: string;
      sku: string | null;
    }>;
  }> = [];

  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(PRODUCTS_QUERY, {
      variables: { cursor },
    });

    const json = (await response.json()) as ProductsResponse;
    const page = json.data.products;

    for (const { node: product } of page.edges) {
      const variantCount = product.variants.edges.length;

      products.push({
        id: product.id,
        title: product.title,
        status: product.status,
        variantLimitExceeded: variantCount >= VARIANT_LIMIT_WARNING_THRESHOLD,
        maxAdditionalVariants: Math.max(0, SHOPIFY_VARIANT_MAX - variantCount),
        variants: product.variants.edges.map(({ node: v }) => ({
          id: v.id,
          title: v.title,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          inventoryQuantity: v.inventoryQuantity,
          inventoryPolicy: v.inventoryPolicy,
          sku: v.sku,
        })),
      });
    }

    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return Response.json({ products });
};
