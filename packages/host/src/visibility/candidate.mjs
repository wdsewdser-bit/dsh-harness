/** The first stage never manufactures request evidence or consumes auxiliary requests. */
export function carriesCandidate(options, slot, isMain) {
  if (!isMain(options) || !slot) return false;
  return options.messages?.some(message => message.id === slot.messageId) ?? false;
}
