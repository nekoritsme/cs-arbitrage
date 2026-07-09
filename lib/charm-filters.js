export function getItemMarketName(item) {
  return item?.nameHash || item?.name || "";
}

export function getAttachmentTitle(attachment) {
  return attachment?.title || attachment?.name || "";
}

export function isStandaloneCharmItem(item) {
  return /^(?:Souvenir\s+)?Charm \|/.test(getItemMarketName(item));
}

export function isRealCharmAttachment(attachment) {
  return /^Charm \|/.test(getAttachmentTitle(attachment));
}

export function filterRealCharmAttachments(attachments) {
  return (attachments ?? []).filter(isRealCharmAttachment);
}

export function hasRealCharmAttachment(item) {
  return filterRealCharmAttachments(item?.charms).length > 0;
}

export function isSkinWithRealCharm(item) {
  return !isStandaloneCharmItem(item) && hasRealCharmAttachment(item);
}
