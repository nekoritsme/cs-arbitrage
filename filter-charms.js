import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { getEnv } from "./lib/env.js";
import { filterRealCharmAttachments, isStandaloneCharmItem } from "./lib/charm-filters.js";
import { dedupeItemsById, readJson, writeJsonAtomic } from "./lib/storage.js";

const INPUT_FILE = getEnv("INPUT_FILE", "charms.json");
const OUTPUT_FILE = getEnv("OUTPUT_FILE", INPUT_FILE);
const BACKUP_FILE = getEnv("BACKUP_FILE", "charms.unfiltered.json");

function countAttachments(items) {
  return items.reduce((total, item) => total + (item.charms?.length ?? 0), 0);
}

async function backupInputIfOverwriting() {
  if (INPUT_FILE !== OUTPUT_FILE) {
    return false;
  }

  try {
    await copyFile(INPUT_FILE, BACKUP_FILE, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function main() {
  const source = await readJson(INPUT_FILE);
  if (!source?.items?.length) {
    console.error(`Нет items в ${INPUT_FILE}`);
    process.exitCode = 1;
    return;
  }

  const originalItems = dedupeItemsById(source.items);
  let removedStandaloneCharmItems = 0;
  let removedItemsWithoutRealCharms = 0;
  let removedAttachments = 0;

  const items = [];

  for (const item of originalItems) {
    if (isStandaloneCharmItem(item)) {
      removedStandaloneCharmItems += 1;
      continue;
    }

    const originalAttachmentCount = item.charms?.length ?? 0;
    const charms = filterRealCharmAttachments(item.charms);
    removedAttachments += originalAttachmentCount - charms.length;

    if (!charms.length) {
      removedItemsWithoutRealCharms += 1;
      continue;
    }

    items.push({
      ...item,
      charms,
    });
  }

  const backedUp = await backupInputIfOverwriting();
  const result = {
    ...source,
    filteredAt: new Date().toISOString(),
    status: source.status ?? "filtered",
    count: items.length,
    filter: {
      ...source.filter,
      localPostFilter: "skins_with_real_charm_attachments_only",
      attachmentTitlePrefix: "Charm |",
      excludesAttachmentPrefixes: ["Sticker Slab |"],
      excludesStandaloneItemPrefixes: ["Charm |", "Souvenir Charm |"],
    },
    filterStats: {
      originalItems: originalItems.length,
      filteredItems: items.length,
      originalAttachments: countAttachments(originalItems),
      filteredAttachments: countAttachments(items),
      removedAttachments,
      removedStandaloneCharmItems,
      removedItemsWithoutRealCharms,
      backupFile: backedUp ? BACKUP_FILE : null,
    },
    items,
  };

  await writeJsonAtomic(OUTPUT_FILE, result);

  console.log(`Очищено: ${originalItems.length} -> ${items.length} items`);
  console.log(`Attachments: ${result.filterStats.originalAttachments} -> ${result.filterStats.filteredAttachments}`);
  console.log(`Удалено sticker/non-charm attachments: ${removedAttachments}`);
  console.log(`Удалено standalone charms: ${removedStandaloneCharmItems}`);
  console.log(`Удалено items без настоящих charms: ${removedItemsWithoutRealCharms}`);
  if (backedUp) {
    console.log(`Backup исходника: ${BACKUP_FILE}`);
  }
  console.log(`Записано: ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("Ошибка:", error.message);
  process.exitCode = 1;
});
