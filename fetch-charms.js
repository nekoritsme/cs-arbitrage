import { getEnv, getEnvBool, getEnvNumber } from "./lib/env.js";
import { isSkinWithRealCharm, isStandaloneCharmItem } from "./lib/charm-filters.js";
import { normalizeMarketNode } from "./lib/market-items.js";
import { ENDPOINT, PARTNER_TOKEN, queryMarketList } from "./lib/white-api.js";
import { dedupeItemsById, readJson, writeJsonAtomic } from "./lib/storage.js";

const OUTPUT_FILE = getEnv("OUTPUT_FILE", "charms.json");
const PAGE_SIZE = getEnvNumber("PAGE_SIZE", 10000);
const RESUME = getEnvBool("RESUME", true);
const RESET = process.argv.includes("--reset");

function buildPayload(state) {
  const items = dedupeItemsById(state.items);

  return {
    fetchedAt: new Date().toISOString(),
    startedAt: state.startedAt,
    status: state.complete ? "complete" : "in_progress",
    source: ENDPOINT,
    filter: {
      appId: "CSGO",
      csgoCharm: true,
      localPostFilter: "skins_with_attached_charms_only",
    },
    apiTotalCount: state.totalCount ?? items.length,
    count: items.length,
    skippedStandaloneCharms: state.skippedStandaloneCharms,
    skippedWithoutCharms: state.skippedWithoutCharms,
    checkpoint: {
      after: state.after,
      page: state.page,
      lastSavedAt: new Date().toISOString(),
    },
    items,
  };
}

async function loadInitialState() {
  if (RESET) {
    console.log("Старт с нуля (--reset)");
    return {
      items: [],
      after: null,
      page: 0,
      totalCount: null,
      skippedStandaloneCharms: 0,
      skippedWithoutCharms: 0,
      startedAt: new Date().toISOString(),
      complete: false,
    };
  }

  if (!RESUME) {
    return {
      items: [],
      after: null,
      page: 0,
      totalCount: null,
      skippedStandaloneCharms: 0,
      skippedWithoutCharms: 0,
      startedAt: new Date().toISOString(),
      complete: false,
    };
  }

  const existing = await readJson(OUTPUT_FILE);
  if (!existing?.items?.length) {
    console.log("Checkpoint не найден, начинаем с нуля");
    return {
      items: [],
      after: null,
      page: 0,
      totalCount: null,
      skippedStandaloneCharms: 0,
      skippedWithoutCharms: 0,
      startedAt: new Date().toISOString(),
      complete: false,
    };
  }

  if (existing.status === "complete") {
    console.log(`Файл уже complete (${existing.count} предметов). Используй --reset для новой загрузки.`);
    return null;
  }

  console.log(`Продолжаем с checkpoint: ${existing.count} предметов, страница ${existing.checkpoint?.page ?? "?"}`);

  return {
    items: existing.items,
    after: existing.checkpoint?.after ?? null,
    page: existing.checkpoint?.page ?? 0,
    totalCount: existing.apiTotalCount ?? existing.totalCount ?? null,
    skippedStandaloneCharms: existing.skippedStandaloneCharms ?? 0,
    skippedWithoutCharms: existing.skippedWithoutCharms ?? 0,
    startedAt: existing.startedAt ?? new Date().toISOString(),
    complete: false,
  };
}

async function saveProgress(state, reason) {
  const payload = buildPayload(state);
  await writeJsonAtomic(OUTPUT_FILE, payload);
  console.log(`[save] ${reason}: ${payload.count} предметов -> ${OUTPUT_FILE}`);
}

async function fetchAllCharmItems(state) {
  while (true) {
    state.page += 1;

    const connection = await queryMarketList({
      search: {
        appId: "CSGO",
        csgoCharm: true,
      },
      page: {
        first: PAGE_SIZE,
        after: state.after,
      },
    });

    if (!connection) {
      throw new Error("Пустой ответ market_list");
    }

    if (state.totalCount == null && connection.totalCount != null) {
      state.totalCount = connection.totalCount;
      console.log(`API вернуло предметов по csgoCharm: ${state.totalCount}`);
    }

    const edges = connection.edges ?? [];
    let addedOnPage = 0;
    let skippedStandaloneOnPage = 0;
    let skippedWithoutCharmsOnPage = 0;

    for (const edge of edges) {
      if (edge?.node) {
        const normalized = normalizeMarketNode(edge.node);

        if (isSkinWithRealCharm(normalized)) {
          state.items.push(normalized);
          addedOnPage += 1;
        } else if (isStandaloneCharmItem(normalized)) {
          state.skippedStandaloneCharms += 1;
          skippedStandaloneOnPage += 1;
        } else {
          state.skippedWithoutCharms += 1;
          skippedWithoutCharmsOnPage += 1;
        }
      }
    }

    state.after = connection.pageInfo?.endCursor ?? null;
    const hasNextPage = connection.pageInfo?.hasNextPage;

    console.log(
      `Страница ${state.page}: +${addedOnPage} скинов, сохранено ${state.items.length}, API ${state.totalCount ?? "?"}, пропущено charms ${skippedStandaloneOnPage}, без charms ${skippedWithoutCharmsOnPage}`,
    );

    await saveProgress(state, `страница ${state.page}`);

    if (!hasNextPage || !state.after) {
      state.complete = true;
      break;
    }
  }

  return state;
}

async function main() {
  if (!PARTNER_TOKEN) {
    console.error("Укажите WHITE_PARTNER_TOKEN в .env");
    console.error("Токен: https://white.market/profile/api");
    process.exitCode = 1;
    return;
  }

  const state = await loadInitialState();
  if (!state) {
    return;
  }

  console.log("Загрузка предметов с charms из white.market...");

  try {
    await fetchAllCharmItems(state);
    await saveProgress(state, "complete");
    console.log(`Готово: ${dedupeItemsById(state.items).length} предметов в ${OUTPUT_FILE}`);
  } catch (error) {
    await saveProgress(state, "ошибка, сохранён прогресс");
    console.error("Ошибка:", error.message);
    console.error(`Прогресс сохранён. Запусти снова — продолжит с ${OUTPUT_FILE}`);
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error("Fatal:", error.message);
  process.exitCode = 1;
});
