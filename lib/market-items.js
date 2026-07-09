import { filterRealCharmAttachments } from "./charm-filters.js";

export function normalizeMarketNode(node) {
  const item = node.item ?? {};
  const description = item.description ?? {};

  return {
    id: node.id,
    slug: node.slug ?? null,
    createdAt: node.createdAt ?? null,
    deliveryType: node.deliveryType ?? null,
    price: node.price ?? null,
    assetId: item.assetId ?? null,
    name: description.name ?? null,
    nameHash: item.nameHash ?? description.nameHash ?? null,
    icon: description.icon ?? null,
    float: item.float ?? null,
    paintSeed: item.paintSeed ?? null,
    paintIndex: item.paintIndex ?? null,
    phase: item.phase ?? null,
    exterior: item.exteriorEnum ?? null,
    inspectLink: item.link ?? null,
    charms: filterRealCharmAttachments(item.charms),
    rawAttachmentCount: item.charms?.length ?? 0,
  };
}
