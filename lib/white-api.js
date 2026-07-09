import { getEnv, getEnvNumber } from "./env.js";

const ENDPOINT = getEnv("WHITE_ENDPOINT", "https://api.white.market/graphql/partner");
const PARTNER_TOKEN = getEnv("WHITE_PARTNER_TOKEN");
const REQUEST_DELAY_MS = getEnvNumber("REQUEST_DELAY_MS", 300);
const HTTP_MAX_RETRIES = getEnvNumber("HTTP_MAX_RETRIES", 8);
const MAX_WAIT_MS = getEnvNumber("MAX_WAIT_MS", 20000);
const FETCH_TIMEOUT_MS = getEnvNumber("FETCH_TIMEOUT_MS", 30000);

const AUTH_MUTATION = `
  mutation AuthToken {
    auth_token {
      accessToken
    }
  }
`;

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status === 503 || (status >= 502 && status <= 504);
}

function isRetryableNetworkError(error) {
  const code = error?.cause?.code || error?.code || "";
  const message = String(error?.message || "");
  return (
    code === "UND_ERR_HEADERS_TIMEOUT"
    || code === "UND_ERR_CONNECT_TIMEOUT"
    || code === "UND_ERR_SOCKET"
    || code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || code === "EAI_AGAIN"
    || message.includes("fetch failed")
    || message.includes("aborted")
  );
}

async function postGraphql(body, headers = {}, attempt = 0) {
  if (REQUEST_DELAY_MS > 0 && attempt === 0) {
    await sleep(REQUEST_DELAY_MS);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const text = await response.text();
    let json = null;

    try {
      json = JSON.parse(text);
    } catch {
      if (isRetryableStatus(response.status) && attempt < HTTP_MAX_RETRIES) {
        const waitMs = Math.min(MAX_WAIT_MS, 1000 * 2 ** attempt + Math.floor(Math.random() * 500));
        console.warn(`[api] invalid JSON (HTTP ${response.status}), retry ${attempt + 1}/${HTTP_MAX_RETRIES}, wait ${waitMs}ms`);
        await sleep(waitMs);
        return postGraphql(body, headers, attempt + 1);
      }

      throw new Error(`Invalid JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`);
    }

    if (response.status === 401) {
      cachedAccessToken = null;
      cachedAccessTokenExpiresAt = 0;
    }

    if (isRetryableStatus(response.status) && attempt < HTTP_MAX_RETRIES) {
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Math.min(MAX_WAIT_MS, 1000 * 2 ** attempt + Math.floor(Math.random() * 500));
      console.warn(`[api] HTTP ${response.status}, retry ${attempt + 1}/${HTTP_MAX_RETRIES}, wait ${waitMs}ms`);
      await sleep(waitMs);
      return postGraphql(body, headers, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`);
    }

    return json;
  } catch (error) {
    if (isRetryableNetworkError(error) && attempt < HTTP_MAX_RETRIES) {
      const waitMs = Math.min(MAX_WAIT_MS, 1000 * 2 ** attempt + Math.floor(Math.random() * 500));
      console.warn(`[api] network error, retry ${attempt + 1}/${HTTP_MAX_RETRIES}, wait ${waitMs}ms`);
      await sleep(waitMs);
      return postGraphql(body, headers, attempt + 1);
    }

    throw error;
  }
}

export async function getAccessToken() {
  if (!PARTNER_TOKEN) {
    throw new Error("WHITE_PARTNER_TOKEN не задан");
  }

  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const json = await postGraphql(
    { query: AUTH_MUTATION },
    { "X-partner-token": PARTNER_TOKEN },
  );

  const accessToken = json?.data?.auth_token?.accessToken;
  if (!accessToken) {
    throw new Error("Не удалось получить accessToken");
  }

  cachedAccessToken = accessToken;
  cachedAccessTokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
  return accessToken;
}

export async function queryMarketList(variables) {
  const token = await getAccessToken();
  const query = `
    query MarketListWithCharms($search: MarketProductSearchInput!, $page: ForwardPaginationInput!) {
      market_list(search: $search, forwardPagination: $page) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            slug
            createdAt
            deliveryType
            price {
              value
              currency
            }
            item {
              assetId
              nameHash
              description {
                name
                nameHash
                icon
              }
              ... on CSGOInventoryItem {
                float
                paintSeed
                paintIndex
                phase
                exteriorEnum
                link
                charms {
                  name
                  title
                  icon
                  minPrice {
                    value
                    currency
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const json = await postGraphql(
    { query, variables },
    { Authorization: `Bearer ${token}` },
  );

  return json?.data?.market_list;
}

export { ENDPOINT, PARTNER_TOKEN };
