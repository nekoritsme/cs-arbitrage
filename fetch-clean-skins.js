import { getEnv, getEnvBool, getEnvNumber } from "./lib/env.js";
import { isSkinWithRealCharm, isStandaloneCharmItem } from "./lib/charm-filters.js";
import { normalizeMarketNode } from "./lib/market-items.js";
import { ENDPOINT, PARTNER_TOKEN, queryMarketList } from "./lib/white-api.js";
import { dedupeItemsById, readJson, writeJsonAtomic } from "./lib/storage.js";
import { getBaseSkinKey, getVariantSkinKey, normalizeExterior } from "./lib/skin-keys.js";

const CHARM_INPUT_FILE = getEnv("CHARM_INPUT_FILE", "charms.json");
const OUTPUT_FILE = getEnv("CLEAN_SKINS_OUTPUT", "clean-skins.json");
const PAGE_SIZE = getEnvNumber("PAGE_SIZE", 100);
const RESUME = getEnvBool("RESUME", true);
const RESET = process.argv.includes("--reset");
const MIN_CLEAN_SKIN_COMPS = getEnvNumber("MIN_CLEAN_SKIN_COMPS", 10);
const MAX_CLEAN_SKIN_COMPS = getEnvNumber("MAX_CLEAN_SKIN_COMPS", 20);

function isCleanComparableSkin(item) {
  return (
    !isStandaloneCharmItem(item)
    && !isSkinWithRealCharm(item)
    && (item.rawAttachmentCount ?? 0) === 0
  );
}

function getConfidenceLevel(compCount) {
  if (compCount >= 20) return "high";
  if (compCount >= 10) return "medium";
  if (compCount >= 5) return "low";
  if (compCount >= 2) return "very_low";
  return "minimal";
}

function countCompsBySkin(items) {
  const counts = new Map();

  for (const item of items) {
    const key = getVariantSkinKey(item);
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function targetCoverage(counts, targetVariantKeys) {
  let covered = 0;

  for (const variantKey of targetVariantKeys) {
    if ((counts.get(variantKey) ?? 0) >= MIN_CLEAN_SKIN_COMPS) {
      covered += 1;
    }
  }

  return {
    targetSkinCount: targetVariantKeys.length,
    coveredSkinCount: covered,
    missingSkinCount: targetVariantKeys.length - covered,
    coverage: targetVariantKeys.length ? covered / targetVariantKeys.length : 0,
  };
}

async function loadTargetVariants() {
  const source = await readJson(CHARM_INPUT_FILE);
  if (!source?.items?.length) {
    throw new Error(`Нет items в ${CHARM_INPUT_FILE}`);
  }

  const charmSkins = source.items.filter(isSkinWithRealCharm);

  // Group by full skin name for querying (API requires full name with exterior)
  const fullSkinNames = [...new Set(charmSkins.map(item => item.nameHash || item.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  // Map of variant key (name+exterior) -> variant info
  const variantMap = new Map();

  for (const item of charmSkins) {
    const fullName = item.nameHash || item.name;
    const baseName = getBaseSkinKey(item);
    const variantKey = getVariantSkinKey(item);

    if (variantKey && baseName) {
      variantMap.set(variantKey, {
        baseName,
        fullName,
        exterior: item.exterior,
      });
    }
  }

  return {
    fullSkinNames,
    variantMap,
    totalVariants: variantMap.size,
  };
}

async function loadInitialState(targetVariants) {
  const freshState = {
    items: [],
    after: null,
    skinIndex: 0,
    skinPage: 0,
    totalCount: null,
    startedAt: new Date().toISOString(),
    complete: false,
  };

  if (RESET || !RESUME) {
    return freshState;
  }

  const existing = await readJson(OUTPUT_FILE);
  if (!existing?.items?.length) {
    console.log("Checkpoint clean skins не найден, начинаем с нуля");
    return freshState;
  }

  const counts = countCompsBySkin(existing.items);
  const targetVariantKeys = Array.from(targetVariants.variantMap.keys());
  const coverage = targetCoverage(counts, targetVariantKeys);
  if (existing.status === "complete" && coverage.missingSkinCount === 0) {
    console.log(`Файл уже complete (${existing.count} clean comps). Используй --reset для новой загрузки.`);
    return null;
  }

  const canResumeTargeted = existing.filter?.queryMode === "full_name_exact_match";
  console.log(
    `Продолжаем clean checkpoint: ${existing.count} comps, skin ${canResumeTargeted ? existing.checkpoint?.skinIndex ?? 0 : 0}`,
  );

  return {
    items: existing.items,
    after: canResumeTargeted ? existing.checkpoint?.after ?? null : null,
    skinIndex: canResumeTargeted ? existing.checkpoint?.skinIndex ?? 0 : 0,
    skinPage: canResumeTargeted ? existing.checkpoint?.skinPage ?? 0 : 0,
    totalCount: existing.apiTotalCount ?? existing.totalCount ?? null,
    startedAt: existing.startedAt ?? new Date().toISOString(),
    complete: false,
  };
}

async function saveProgress(state, targetVariants, reason) {
  const items = dedupeItemsById(state.items);
  const counts = countCompsBySkin(items);
  const targetVariantKeys = Array.from(targetVariants.variantMap.keys());
  const coverage = targetCoverage(counts, targetVariantKeys);

  // Calculate detailed coverage statistics
  const coverageStats = {
    gte1: 0,
    gte5: 0,
    gte10: 0,
    gte20: 0,
  };

  for (const count of counts.values()) {
    if (count >= 1) coverageStats.gte1++;
    if (count >= 5) coverageStats.gte5++;
    if (count >= 10) coverageStats.gte10++;
    if (count >= 20) coverageStats.gte20++;
  }

  await writeJsonAtomic(OUTPUT_FILE, {
    fetchedAt: new Date().toISOString(),
    startedAt: state.startedAt,
    status: state.complete ? "complete" : "in_progress",
    source: ENDPOINT,
    sourceCharmFile: CHARM_INPUT_FILE,
    filter: {
      appId: "CSGO",
      queryMode: "full_name_exact_match",
      localPostFilter: "clean_skins_exact_variant_match",
      excludesCsgoCharm: true,
      excludesCsgoStickers: true,
      excludesAnyRawAttachments: true,
      minCleanSkinComps: MIN_CLEAN_SKIN_COMPS,
      maxCleanSkinComps: MAX_CLEAN_SKIN_COMPS,
      matchBy: ["name", "exterior"],
      sort: "PRICE_ASC",
    },
    apiTotalCount: state.totalCount ?? null,
    count: items.length,
    coverage: {
      ...coverage,
      coverage: Number(coverage.coverage.toFixed(4)),
      detailed: coverageStats,
    },
    checkpoint: {
      after: state.after,
      skinIndex: state.skinIndex,
      skinPage: state.skinPage,
      lastSavedAt: new Date().toISOString(),
    },
    items,
  });

  console.log(
    `[save] ${reason}: ${items.length} clean comps, coverage ${coverage.coveredSkinCount}/${coverage.targetSkinCount} (>=1:${coverageStats.gte1}, >=5:${coverageStats.gte5}, >=10:${coverageStats.gte10}, >=20:${coverageStats.gte20}) -> ${OUTPUT_FILE}`,
  );
}

async function fetchCleanSkins(state, targetVariants) {
  const { fullSkinNames, variantMap } = targetVariants;
  const targetVariantKeys = Array.from(variantMap.keys());

  for (state.skinIndex = state.skinIndex ?? 0; state.skinIndex < fullSkinNames.length; state.skinIndex++) {
    const fullName = fullSkinNames[state.skinIndex];
    const baseName = getBaseSkinKey({ nameHash: fullName });
    state.skinPage = state.skinPage ?? 0;
    state.after = null;

    const counts = countCompsBySkin(dedupeItemsById(state.items));

    // Check which variants of this skin need more comps
    const variantsNeedingComps = [];
    for (const [variantKey, variant] of variantMap.entries()) {
      if (variant.fullName !== fullName) continue;
      const currentCount = counts.get(variantKey) ?? 0;
      if (currentCount < MAX_CLEAN_SKIN_COMPS) {
        variantsNeedingComps.push({ variantKey, currentCount });
      }
    }

    if (variantsNeedingComps.length === 0) {
      console.log(`Skin ${state.skinIndex + 1}/${fullSkinNames.length}: "${fullName}" уже имеет максимальные comps, пропускаем`);
      continue;
    }

    console.log(`Skin ${state.skinIndex + 1}/${fullSkinNames.length}: fetching "${fullName}" (${variantsNeedingComps.length} variants need comps)`);

    while (true) {
      state.skinPage += 1;

      const connection = await queryMarketList({
        search: {
          appId: "CSGO",
          namesHash: [fullName],
          csgoCharm: false,
          csgoStickers: false,
          sort: {
            field: "PRICE",
            type: "ASC",
          },
        },
        page: {
          first: PAGE_SIZE,
          after: state.after,
        },
      });

      if (!connection) {
        throw new Error("Пустой ответ market_list");
      }

      let addedOnPage = 0;

      for (const edge of connection.edges ?? []) {
        if (!edge?.node) {
          continue;
        }

        const normalized = normalizeMarketNode(edge.node);
        const variantKey = getVariantSkinKey(normalized);

        // Only use clean comps that match exact variant (name + exterior)
        // Continue fetching until we reach MAX_CLEAN_SKIN_COMPS
        if (variantMap.has(variantKey)) {
          const currentCount = counts.get(variantKey) ?? 0;
          if (currentCount < MAX_CLEAN_SKIN_COMPS && isCleanComparableSkin(normalized)) {
            state.items.push(normalized);
            counts.set(variantKey, currentCount + 1);
            addedOnPage += 1;
          }
        }
      }

      state.after = connection.pageInfo?.endCursor ?? null;
      const hasNextPage = connection.pageInfo?.hasNextPage;
      const newCounts = countCompsBySkin(dedupeItemsById(state.items));
      const coverage = targetCoverage(newCounts, targetVariantKeys);

      // Recalculate which variants still need comps
      const stillNeedingComps = [];
      for (const [variantKey, variant] of variantMap.entries()) {
        if (variant.fullName !== fullName) continue;
        const currentCount = newCounts.get(variantKey) ?? 0;
        if (currentCount < MIN_CLEAN_SKIN_COMPS) {
          stillNeedingComps.push(variantKey);
        }
      }

      console.log(
        `  Page ${state.skinPage}: +${addedOnPage} clean comps for "${fullName}" (${stillNeedingComps.length} variants below ${MIN_CLEAN_SKIN_COMPS}), total coverage ${coverage.coveredSkinCount}/${coverage.targetSkinCount}`,
      );

      await saveProgress(state, targetVariants, `skin ${state.skinIndex + 1}/${fullSkinNames.length}, page ${state.skinPage}`);

      // Stop if all variants have at least MIN_CLEAN_SKIN_COMPS or no more results
      if (stillNeedingComps.length === 0 || !hasNextPage || !state.after) {
        break;
      }
    }

    state.skinPage = 0;
  }

  state.complete = true;
  return state;
}

async function main() {
  if (!PARTNER_TOKEN) {
    console.error("Укажите WHITE_PARTNER_TOKEN в .env");
    process.exitCode = 1;
    return;
  }

  const targetVariants = await loadTargetVariants();
  console.log(`Ищу clean comps для ${targetVariants.fullSkinNames.length} skin names (${targetVariants.totalVariants} variants) из ${CHARM_INPUT_FILE}`);

  const state = await loadInitialState(targetVariants);
  if (!state) {
    return;
  }

  try {
    await fetchCleanSkins(state, targetVariants);
    await saveProgress(state, targetVariants, state.complete ? "complete" : "checkpoint");
    console.log(`Готово: ${dedupeItemsById(state.items).length} clean comps в ${OUTPUT_FILE}`);
  } catch (error) {
    await saveProgress(state, targetVariants, "ошибка, сохранён прогресс");
    console.error("Ошибка:", error.message);
    console.error(`Прогресс сохранён. Запусти снова — продолжит с ${OUTPUT_FILE}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Fatal:", error.message);
  process.exitCode = 1;
});
