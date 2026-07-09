import { getEnv, getEnvNumber } from "./lib/env.js";
import { filterRealCharmAttachments, isSkinWithRealCharm } from "./lib/charm-filters.js";
import { readJson, writeJsonAtomic } from "./lib/storage.js";
import { getVariantSkinKey } from "./lib/skin-keys.js";

const INPUT_FILE = getEnv("INPUT_FILE", "charms.json");
const CLEAN_SKINS_FILE = getEnv("CLEAN_SKINS_FILE", "clean-skins.json");
const OUTPUT_FILE = getEnv("ANALYSIS_OUTPUT", "analysis.json");
const DETACH_COST = getEnvNumber("DETACH_COST", 0.25);
const FEE_RATE = getEnvNumber("FEE_RATE", 0.05);
const MIN_PROFIT = getEnvNumber("MIN_PROFIT", 1);
const MIN_ROI = getEnvNumber("MIN_ROI", 0);
const MIN_SKIN_COMPS = getEnvNumber("MIN_SKIN_COMPS", 5);
const SKIN_REFERENCE_METHOD = getEnv("SKIN_REFERENCE_METHOD", "p25").toLowerCase();
const SKIN_SELL_DISCOUNT = getEnvNumber("SKIN_SELL_DISCOUNT", 0);
const CHARM_SELL_DISCOUNT = getEnvNumber("CHARM_SELL_DISCOUNT", 0);
const TOP_N = getEnvNumber("TOP_N", 50);
const DETACH_STRATEGY = getEnv("DETACH_STRATEGY", "optimal").toLowerCase(); // "all", "optimal", "none"

function parseMoney(value) {
  if (value == null) {
    return null;
  }
  const num = Number(String(value).replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

function round(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(digits));
}

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function avg(values) {
  return values.length ? sum(values) / values.length : 0;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index];
}

function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function getSkinKey(item) {
  return getVariantSkinKey(item);
}

function calculateCharmProfitability(charms, strategy) {
  const profitableCharms = [];
  const skippedCharms = [];

  for (const charm of charms) {
    const sellPrice = charm.minPrice * (1 - CHARM_SELL_DISCOUNT);
    const sellFee = sellPrice * FEE_RATE;
    const detachCost = DETACH_COST;
    const netCharmValue = sellPrice - sellFee - detachCost;

    if (strategy === "all") {
      profitableCharms.push({ ...charm, netCharmValue });
    } else if (strategy === "none") {
      skippedCharms.push({ ...charm, netCharmValue });
    } else if (strategy === "optimal") {
      if (netCharmValue > 0) {
        profitableCharms.push({ ...charm, netCharmValue });
      } else {
        skippedCharms.push({ ...charm, netCharmValue });
      }
    }
  }

  return {
    profitableCharms,
    skippedCharms,
    profitableCharmCount: profitableCharms.length,
    skippedCharmCount: skippedCharms.length,
    detachedCharmValue: profitableCharms.reduce((sum, c) => sum + c.netCharmValue, 0),
    skippedCharmValue: skippedCharms.reduce((sum, c) => sum + c.netCharmValue, 0),
    detachedCharmNames: profitableCharms.map(c => c.title),
    skippedCharmNames: skippedCharms.map(c => c.title),
  };
}

function selectSkinReference(stats) {
  if (!stats) {
    return null;
  }

  switch (SKIN_REFERENCE_METHOD) {
    case "min":
      return stats.min;
    case "median":
      return stats.median;
    case "p75":
      return stats.p75;
    case "p25":
    default:
      return stats.p25;
  }
}

function buildSkinStats(items) {
  const byNameHash = new Map();

  for (const item of items) {
    const key = getSkinKey(item);
    const price = parseMoney(item.price?.value);
    if (!key || price == null) {
      continue;
    }

    if (!byNameHash.has(key)) {
      byNameHash.set(key, []);
    }
    byNameHash.get(key).push(price);
  }

  const stats = new Map();

  for (const [nameHash, prices] of byNameHash) {
    const sorted = [...prices].sort((a, b) => a - b);
    stats.set(nameHash, {
      count: sorted.length,
      min: sorted[0],
      p25: percentile(sorted, 25),
      median: median(sorted),
      p75: percentile(sorted, 75),
      max: sorted[sorted.length - 1],
    });
  }

  return stats;
}

function normalizeCharms(item) {
  return filterRealCharmAttachments(item.charms).map((charm) => ({
    name: charm.name,
    title: charm.title,
    minPrice: parseMoney(charm.minPrice?.value),
    currency: charm.minPrice?.currency ?? item.price?.currency ?? "USD",
  }));
}

function buildRiskFlags({ cleanSkin, listingPrice, cleanSkinReference, charmTotal, roi, isSkinListing }) {
  const flags = [];

  if (!isSkinListing) {
    flags.push("not_skin_listing");
  }
  if (!cleanSkin || cleanSkin.count < MIN_SKIN_COMPS) {
    flags.push("few_clean_skin_comps");
  }
  if (charmTotal <= 0) {
    flags.push("missing_charm_value");
  }
  if (cleanSkinReference == null) {
    flags.push("missing_clean_skin_reference");
  }
  if (listingPrice > 0 && charmTotal / listingPrice < 0.05) {
    flags.push("low_charm_share");
  }
  if (roi < 0.03) {
    flags.push("thin_roi");
  }

  return flags;
}

function confidenceFromFlags(flags) {
  if (flags.includes("not_skin_listing") || flags.includes("missing_clean_skin_reference")) {
    return "ignore";
  }
  if (flags.length === 0) {
    return "high";
  }
  if (flags.length <= 2 && !flags.includes("missing_charm_value")) {
    return "medium";
  }
  return "low";
}

function analyzeItem(item, cleanSkinStats) {
  const listingPrice = parseMoney(item.price?.value);
  if (listingPrice == null) {
    return null;
  }

  const charms = normalizeCharms(item);
  const charmTotal = sum(charms.map((charm) => charm.minPrice ?? 0));
  const skinKey = getSkinKey(item);
  const cleanSkin = cleanSkinStats.get(skinKey) ?? null;
  const cleanSkinReference = selectSkinReference(cleanSkin);
  const isSkinListing = isSkinWithRealCharm(item);

  const skinResellEstimate = cleanSkinReference != null
    ? cleanSkinReference * (1 - SKIN_SELL_DISCOUNT)
    : 0;

  // Calculate optimal charm detachment
  const charmProfitability = calculateCharmProfitability(charms, DETACH_STRATEGY);
  const { profitableCharms, detachedCharmValue, detachedCharmNames, profitableCharmCount, skippedCharmCount, skippedCharmValue } = charmProfitability;

  const charmResellEstimate = detachedCharmValue;
  const grossProceeds = skinResellEstimate + charmResellEstimate;
  const sellFees = grossProceeds * FEE_RATE;
  const detachCostTotal = DETACH_COST * profitableCharms.length;
  const totalCost = listingPrice + detachCostTotal;
  const totalCostWithFees = totalCost + sellFees;
  const estimatedNetProfit = grossProceeds - totalCostWithFees;
  const roi = totalCost > 0 ? estimatedNetProfit / totalCost : 0;

  const listingVsSkinReference = cleanSkinReference != null ? listingPrice - cleanSkinReference : null;
  const charmShare = listingPrice > 0 ? charmTotal / listingPrice : null;
  const impliedFreeCharm = cleanSkinReference != null ? cleanSkinReference + charmTotal - listingPrice : null;
  const breakEvenGross = FEE_RATE < 1 ? totalCost / (1 - FEE_RATE) : null;
  const breakEvenCharmSell = breakEvenGross != null
    ? Math.max(0, breakEvenGross - skinResellEstimate)
    : null;
  const charmMarginAfterPremium = listingVsSkinReference != null
    ? charmTotal - Math.max(0, listingVsSkinReference)
    : null;
  const charmNetEdge = charmMarginAfterPremium != null
    ? charmMarginAfterPremium - detachCostTotal - sellFees
    : null;

  // New profit breakdown metrics
  const skinEdge = cleanSkinReference != null
    ? skinResellEstimate - listingPrice
    : null;

  const premiumPaidForCharms = cleanSkinReference != null
    ? Math.max(0, listingPrice - cleanSkinReference)
    : null;

  const rawCharmValue = charmResellEstimate;

  const charmEdgeBeforeFees = premiumPaidForCharms != null
    ? rawCharmValue - premiumPaidForCharms
    : null;

  // Charm fees proportion
  const charmSellFees = charmResellEstimate * FEE_RATE;
  const charmEdge = charmEdgeBeforeFees != null
    ? charmEdgeBeforeFees - detachCostTotal - charmSellFees
    : null;

  // Separate profit components
  const skinProfit = skinEdge ?? 0;
  const charmProfit = charmEdge ?? 0;
  const totalProfit = estimatedNetProfit; // Use the actual calculated profit based on optimal detachment

  // Profit source classification
  let profitSource = null;
  if (totalProfit > 0) {
    const skinEdgeAbs = Math.abs(skinEdge ?? 0);
    const charmEdgeAbs = Math.abs(charmEdge ?? 0);
    const totalEdge = skinEdgeAbs + charmEdgeAbs;

    if (totalEdge > 0) {
      const skinPercent = skinEdgeAbs / totalEdge;
      const charmPercent = charmEdgeAbs / totalEdge;

      if (skinPercent >= 0.8) {
        profitSource = "skin";
      } else if (charmPercent >= 0.8) {
        profitSource = "charms";
      } else {
        profitSource = "mixed";
      }
    }
  }

  const skinEdgePercent = skinEdge != null && listingPrice > 0
    ? (skinEdge / listingPrice) * 100
    : null;

  const charmEdgePercent = charmEdge != null && listingPrice > 0
    ? (charmEdge / listingPrice) * 100
    : null;

  const flags = buildRiskFlags({
    cleanSkin,
    listingPrice,
    cleanSkinReference,
    charmTotal,
    roi,
    isSkinListing,
  });
  const confidence = confidenceFromFlags(flags);
  const isOpportunity = (
    isSkinListing
    && totalProfit >= MIN_PROFIT
    && roi >= MIN_ROI
    && cleanSkinReference != null
    && cleanSkin?.count >= MIN_SKIN_COMPS
    && (DETACH_STRATEGY === 'none' || profitableCharmCount > 0)
  );

  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    nameHash: item.nameHash,
    listingPrice,
    currency: item.price?.currency ?? "USD",
    float: item.float,
    exterior: item.exterior,
    charms,
    charmCount: charms.length,
    charmTotal: round(charmTotal),
    cleanSkinStats: cleanSkin,
    cleanSkinReference: round(cleanSkinReference),
    skinReference: round(cleanSkinReference),
    skinReferenceMethod: SKIN_REFERENCE_METHOD,
    skinResellEstimate: round(skinResellEstimate),
    charmResellEstimate: round(charmResellEstimate),
    grossProceeds: round(grossProceeds),
    detachCostPerCharm: DETACH_COST,
    detachCost: round(detachCostTotal),
    sellFees: round(sellFees),
    totalCost: round(totalCost),
    totalCostWithFees: round(totalCostWithFees),
    estimatedNetProfit: round(totalProfit), // Now represents totalProfit for backward compatibility
    actualTotalProfit: round(totalProfit),
    roi: round(roi, 4),
    roiPercent: round(roi * 100, 2),
    listingVsSkinReference: round(listingVsSkinReference),
    charmShare: round(charmShare, 4),
    impliedFreeCharm: round(impliedFreeCharm),
    breakEvenCharmSell: round(breakEvenCharmSell),
    charmMarginAfterPremium: round(charmMarginAfterPremium),
    charmNetEdge: round(charmNetEdge),
    // New profit breakdown fields
    skinEdge: round(skinEdge),
    skinEdgePercent: round(skinEdgePercent, 2),
    premiumPaidForCharms: round(premiumPaidForCharms),
    rawCharmValue: round(rawCharmValue),
    charmEdgeBeforeFees: round(charmEdgeBeforeFees),
    charmEdge: round(charmEdge),
    charmEdgePercent: round(charmEdgePercent, 2),
    profitSource,
    // Separate profit components
    skinProfit: round(skinProfit),
    charmProfit: round(charmProfit),
    totalProfit: round(totalProfit),
    // Charm profitability diagnostics
    profitableCharmCount: charmProfitability.profitableCharmCount,
    skippedCharmCount: charmProfitability.skippedCharmCount,
    detachedCharmValue: round(detachedCharmValue),
    skippedCharmValue: round(charmProfitability.skippedCharmValue),
    detachedCharmNames,
    skippedCharmNames: charmProfitability.skippedCharmNames,
    detachStrategy: DETACH_STRATEGY,
    isSkinListing,
    isOpportunity,
    confidence,
    riskFlags: flags,
  };
}

function buildPortfolioSummary(opportunities, limit = null) {
  const items = limit == null ? opportunities : opportunities.slice(0, limit);
  const profits = items.map((item) => item.totalProfit);
  const capital = sum(items.map((item) => item.totalCost));
  const fees = sum(items.map((item) => item.sellFees));
  const charmValue = sum(items.map((item) => item.charmResellEstimate));
  const skinValue = sum(items.map((item) => item.skinResellEstimate));

  return {
    count: items.length,
    capitalRequired: round(capital),
    expectedGrossProceeds: round(charmValue + skinValue),
    expectedFees: round(fees),
    expectedNetProfit: round(sum(profits)),
    expectedRoi: capital > 0 ? round(sum(profits) / capital, 4) : 0,
    expectedRoiPercent: capital > 0 ? round((sum(profits) / capital) * 100, 2) : 0,
    avgProfit: round(avg(profits)),
    avgListingPrice: round(avg(items.map((item) => item.listingPrice))),
    avgCharmValue: round(avg(items.map((item) => item.charmTotal))),
  };
}

function summarize(items, opportunities) {
  const skinListings = items.filter((item) => item.isSkinListing);
  const analyzableSkinListings = skinListings.filter((item) => item.cleanSkinReference != null);
  const missingCleanReference = skinListings.length - analyzableSkinListings.length;
  const ignoredStandaloneCharms = items.length - skinListings.length;
  const charmTotals = skinListings.map((item) => item.charmTotal).filter((value) => value > 0);
  const profits = opportunities.map((item) => item.totalProfit);
  const highConfidence = opportunities.filter((item) => item.confidence === "high");
  const mediumConfidence = opportunities.filter((item) => item.confidence === "medium");
  const skinPortfolio = buildPortfolioSummary(analyzableSkinListings);

  return {
    totalListings: items.length,
    analyzedSkinListings: skinListings.length,
    analyzableSkinListings: analyzableSkinListings.length,
    missingCleanReference,
    ignoredStandaloneCharms,
    opportunities: opportunities.length,
    highConfidenceOpportunities: highConfidence.length,
    mediumConfidenceOpportunities: mediumConfidence.length,
    opportunityRate: skinListings.length ? round(opportunities.length / skinListings.length, 4) : 0,
    totalEstimatedProfitAll: round(sum(profits)),
    totalCapitalRequiredAll: round(sum(opportunities.map((item) => item.totalCost))),
    totalExpectedFeesAll: round(sum(opportunities.map((item) => item.sellFees))),
    totalEstimatedProfitIfBuyingEveryAnalyzableSkinListing: skinPortfolio.expectedNetProfit,
    totalCapitalIfBuyingEveryAnalyzableSkinListing: skinPortfolio.capitalRequired,
    roiIfBuyingEveryAnalyzableSkinListingPercent: skinPortfolio.expectedRoiPercent,
    roiAll: opportunities.length ? buildPortfolioSummary(opportunities).expectedRoi : 0,
    roiAllPercent: opportunities.length ? buildPortfolioSummary(opportunities).expectedRoiPercent : 0,
    avgCharmTotal: round(avg(charmTotals)),
    medianProfit: round(median(profits)),
    maxEstimatedProfit: profits.length ? Math.max(...profits) : 0,
    avgEstimatedProfitTop: round(avg(profits.slice(0, TOP_N))),
    portfolioTop10: buildPortfolioSummary(opportunities, 10),
    portfolioTop25: buildPortfolioSummary(opportunities, 25),
    portfolioTopN: buildPortfolioSummary(opportunities, TOP_N),
    portfolioAll: buildPortfolioSummary(opportunities),
    portfolioEveryAnalyzableSkinListing: skinPortfolio,
  };
}

function groupTopCharms(items, limit = 20) {
  const totals = new Map();

  for (const item of items) {
    for (const charm of item.charms ?? []) {
      const key = charm.title || charm.name;
      const price = parseMoney(charm.minPrice?.value);
      if (!key || price == null) {
        continue;
      }

      const current = totals.get(key) ?? {
        title: key,
        count: 0,
        minAsk: price,
        maxAsk: price,
        totalAsk: 0,
      };
      current.count += 1;
      current.minAsk = Math.min(current.minAsk, price);
      current.maxAsk = Math.max(current.maxAsk, price);
      current.totalAsk += price;
      totals.set(key, current);
    }
  }

  return [...totals.values()]
    .map((item) => ({
      ...item,
      avgAsk: round(item.totalAsk / item.count),
      totalAsk: round(item.totalAsk),
    }))
    .sort((a, b) => b.maxAsk - a.maxAsk || b.count - a.count)
    .slice(0, limit);
}

function groupOpportunities(opportunities, getKey, buildValue, limit = 20) {
  const groups = new Map();

  for (const item of opportunities) {
    const key = getKey(item);
    if (!key) {
      continue;
    }

    const current = groups.get(key) ?? {
      key,
      count: 0,
      totalProfit: 0,
      totalCapital: 0,
      bestProfit: Number.NEGATIVE_INFINITY,
      bestItem: null,
      values: [],
    };
    current.count += 1;
    current.totalProfit += item.totalProfit;
    current.totalCapital += item.totalCost;
    current.bestProfit = Math.max(current.bestProfit, item.totalProfit);
    current.bestItem = current.bestItem && current.bestItem.totalProfit >= item.totalProfit
      ? current.bestItem
      : item;
    current.values.push(buildValue(item));
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      count: group.count,
      totalProfit: round(group.totalProfit),
      totalCapital: round(group.totalCapital),
      roiPercent: group.totalCapital > 0 ? round((group.totalProfit / group.totalCapital) * 100, 2) : 0,
      avgProfit: round(group.totalProfit / group.count),
      bestProfit: round(group.bestProfit),
      bestSlug: group.bestItem?.slug ?? null,
      sample: group.values[0],
    }))
    .sort((a, b) => b.totalProfit - a.totalProfit || b.bestProfit - a.bestProfit)
    .slice(0, limit);
}

function buildCharmOpportunityGroups(opportunities) {
  return groupOpportunities(
    opportunities.flatMap((item) => item.charms.map((charm) => ({
      ...item,
      groupCharmTitle: charm.title || charm.name,
      groupCharmPrice: charm.minPrice,
    }))),
    (item) => item.groupCharmTitle,
    (item) => ({
      skin: item.nameHash,
      charmPrice: item.groupCharmPrice,
      profit: item.totalProfit,
    }),
  );
}

function buildSkinOpportunityGroups(opportunities) {
  return groupOpportunities(
    opportunities,
    (item) => item.nameHash || item.name,
    (item) => ({
      listingPrice: item.listingPrice,
      charmTotal: item.charmTotal,
      profit: item.totalProfit,
      roiPercent: item.roiPercent,
    }),
  );
}

function bucketize(items, getValue, buckets) {
  return buckets.map((bucket) => {
    const values = items.filter((item) => {
      const value = getValue(item);
      return value >= bucket.min && (bucket.max == null || value < bucket.max);
    });
    const profits = values.map((item) => item.totalProfit);
    const capital = sum(values.map((item) => item.totalCost));

    return {
      label: bucket.label,
      count: values.length,
      totalProfit: round(sum(profits)),
      avgProfit: round(avg(profits)),
      roiPercent: capital > 0 ? round((sum(profits) / capital) * 100, 2) : 0,
    };
  });
}

function buildMarketSegments(opportunities) {
  return {
    byListingPrice: bucketize(opportunities, (item) => item.listingPrice, [
      { label: "$0-5", min: 0, max: 5 },
      { label: "$5-20", min: 5, max: 20 },
      { label: "$20-50", min: 20, max: 50 },
      { label: "$50-100", min: 50, max: 100 },
      { label: "$100+", min: 100, max: null },
    ]),
    byRoi: bucketize(opportunities, (item) => item.roiPercent, [
      { label: "0-5%", min: 0, max: 5 },
      { label: "5-15%", min: 5, max: 15 },
      { label: "15-30%", min: 15, max: 30 },
      { label: "30-100%", min: 30, max: 100 },
      { label: "100%+", min: 100, max: null },
    ]),
    byCharmCount: bucketize(opportunities, (item) => item.charmCount, [
      { label: "1 charm", min: 1, max: 2 },
      { label: "2 charms", min: 2, max: 3 },
      { label: "3 charms", min: 3, max: 4 },
      { label: "4+ charms", min: 4, max: null },
    ]),
  };
}

async function main() {
  const source = await readJson(INPUT_FILE);
  if (!source?.items?.length) {
    console.error(`Нет данных в ${INPUT_FILE}. Сначала запусти fetch-charms.js`);
    process.exitCode = 1;
    return;
  }

  const cleanSkinSource = await readJson(CLEAN_SKINS_FILE);
  if (!cleanSkinSource?.items?.length) {
    console.error(`Нет clean baseline в ${CLEAN_SKINS_FILE}. Сначала запусти fetch-clean-skins.js`);
    process.exitCode = 1;
    return;
  }

  const skinStats = buildSkinStats(cleanSkinSource.items);
  const analyzed = source.items
    .map((item) => analyzeItem(item, skinStats))
    .filter(Boolean);

  const opportunities = analyzed
    .filter((item) => item.isOpportunity)
    .sort((a, b) => b.totalProfit - a.totalProfit);

  const topByRoi = [...opportunities]
    .sort((a, b) => b.roi - a.roi || b.totalProfit - a.totalProfit)
    .slice(0, TOP_N);

  const topByCharmShare = [...analyzed]
    .filter((item) => item.isSkinListing && item.charmShare != null && item.charmTotal > 0)
    .sort((a, b) => b.charmShare - a.charmShare)
    .slice(0, TOP_N);

  const result = {
    analyzedAt: new Date().toISOString(),
    sourceFile: INPUT_FILE,
    cleanSkinsFile: CLEAN_SKINS_FILE,
    datasetStatus: source.status ?? "unknown",
    datasetCount: source.count ?? source.items.length,
    cleanDatasetStatus: cleanSkinSource.status ?? "unknown",
    cleanDatasetCount: cleanSkinSource.count ?? cleanSkinSource.items.length,
    cleanDatasetCoverage: cleanSkinSource.coverage ?? null,
    assumptions: {
      detachCost: DETACH_COST,
      detachCostUnit: "per charm attachment",
      feeRate: FEE_RATE,
      minProfit: MIN_PROFIT,
      minRoi: MIN_ROI,
      minSkinComps: MIN_SKIN_COMPS,
      skinReferenceMethod: `${SKIN_REFERENCE_METHOD} price of clean same-skin listings from ${CLEAN_SKINS_FILE}`,
      skinSellDiscount: SKIN_SELL_DISCOUNT,
      charmSellDiscount: CHARM_SELL_DISCOUNT,
      note: "Это скрининг, не гарантия сделки. Базовая цена скина берётся из clean-skins baseline без attachments, а minPrice чарма — текущий минимальный ask.",
    },
    summary: summarize(analyzed, opportunities),
    marketSegments: buildMarketSegments(opportunities),
    topOpportunities: opportunities.slice(0, TOP_N),
    topCharmOpportunities: [...opportunities]
      .filter(item => item.charmEdge != null && item.charmEdge > 0)
      .sort((a, b) => (b.charmEdge ?? 0) - (a.charmEdge ?? 0) || (b.totalProfit - a.totalProfit))
      .slice(0, TOP_N),
    topByRoi,
    topByCharmShare,
    topSkinsByProfit: buildSkinOpportunityGroups(opportunities),
    topCharmsByProfit: buildCharmOpportunityGroups(opportunities),
    topCharmsByMarketPrice: groupTopCharms(source.items),
    allAnalyzed: analyzed,
  };

  await writeJsonAtomic(OUTPUT_FILE, result);

  console.log("=== Анализ рынка charms ===");
  console.log(`Стратегия отсоединения чармов: ${DETACH_STRATEGY}`);
  console.log(`Листингов всего: ${result.summary.totalListings}`);
  console.log(`Скинов с charms: ${result.summary.analyzedSkinListings}`);
  console.log(`Standalone charms проигнорировано: ${result.summary.ignoredStandaloneCharms}`);
  console.log(`Возможностей (profit >= $${MIN_PROFIT}, ROI >= ${(MIN_ROI * 100).toFixed(1)}%): ${result.summary.opportunities}`);
  console.log(`Общий ожидаемый профит по всем: $${result.summary.totalEstimatedProfitAll}`);
  console.log(`Нужный капитал по всем: $${result.summary.totalCapitalRequiredAll}`);
  console.log(`ROI по всем: ${result.summary.roiAllPercent}%`);
  console.log(`С clean baseline: ${result.summary.analyzableSkinListings}/${result.summary.analyzedSkinListings}, missing ${result.summary.missingCleanReference}`);
  console.log(`Если купить все analyzable skin listings: $${result.summary.totalEstimatedProfitIfBuyingEveryAnalyzableSkinListing} на $${result.summary.totalCapitalIfBuyingEveryAnalyzableSkinListing} капитала (${result.summary.roiIfBuyingEveryAnalyzableSkinListingPercent}% ROI)`);
  console.log(`Top-${Math.min(TOP_N, result.summary.portfolioTopN.count)} профит: $${result.summary.portfolioTopN.expectedNetProfit} на $${result.summary.portfolioTopN.capitalRequired} капитала`);
  console.log(`Макс. оценка профита: $${result.summary.maxEstimatedProfit}`);

  // Market diagnostics - calculate actual charm profitability based on net value
  let totalCharms = 0;
  let totalProfitableCharms = 0;
  let totalSkippedCharms = 0;
  let totalDetachedValue = 0;
  let totalSkippedValue = 0;

  for (const item of analyzed) {
    const charms = item.charms || [];
    for (const charm of charms) {
      totalCharms++;
      const charmValue = charm.minPrice || 0;
      const detachCost = DETACH_COST;
      const premiumPaid = item.premiumPaidForCharms || 0;
      const charmShareOfPremium = charms.length > 0 ? premiumPaid / charms.length : 0;
      const netValue = charmValue - detachCost - charmShareOfPremium;

      if (netValue > 0) {
        totalProfitableCharms++;
        totalDetachedValue += charmValue;
      } else {
        totalSkippedCharms++;
        totalSkippedValue += Math.abs(netValue);
      }
    }
  }

  console.log("\n=== Диагностика рынка чармов ===");
  console.log(`Всего чармов: ${totalCharms}`);
  console.log(`Прибыльных чармов (net > 0): ${totalProfitableCharms} (${(totalProfitableCharms / totalCharms * 100).toFixed(1)}%)`);
  console.log(`Убыточных чармов (net <= 0): ${totalSkippedCharms} (${(totalSkippedCharms / totalCharms * 100).toFixed(1)}%)`);
  console.log(`Стоимость прибыльных чармов: $${totalDetachedValue.toFixed(2)}`);
  console.log(`Потенциальные потери на убыточных: $${totalSkippedValue.toFixed(2)}`);

  console.log("\nТоп-5 по общему профиту:");

  for (const item of result.topOpportunities.slice(0, 5)) {
    const charmNames = item.charms.map((charm) => charm.title).join(", ");
    console.log(
      `  Profit: $${item.totalProfit.toFixed(2)} (skin: $${item.skinProfit?.toFixed(2) ?? 'N/A'}, charms: $${item.charmProfit?.toFixed(2) ?? 'N/A'}) | ROI ${item.roiPercent.toFixed(2)}% | buy $${item.listingPrice.toFixed(2)} | ${item.nameHash} | ${charmNames}`,
    );
    console.log(`    Profitable charms: ${item.profitableCharmCount}/${item.charmCount} | Source: ${item.profitSource ?? 'N/A'}`);
  }

  console.log("\nТоп-5 по charm edge:");

  for (const item of result.topCharmOpportunities.slice(0, 5)) {
    const charmNames = item.charms.map((charm) => charm.title).join(", ");
    console.log(
      `  Charm edge: $${item.charmEdge?.toFixed(2) ?? 'N/A'} | Premium paid: $${item.premiumPaidForCharms?.toFixed(2) ?? 'N/A'} | Charm value: $${item.rawCharmValue?.toFixed(2) ?? 'N/A'} | ${item.nameHash} | ${charmNames}`,
    );
    console.log(`    Profitable: ${item.profitableCharmCount}/${item.charmCount} | Skipped: ${item.skippedCharmCount}`);
  }

}

main().catch((error) => {
  console.error("Ошибка:", error.message);
  process.exitCode = 1;
});
