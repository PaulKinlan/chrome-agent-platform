// An absent OPFS handle is optional only when the browser's typed error says
// so. A fake (or a broken adapter) may put NotFoundError in an ordinary Error's
// name/message; treating that as absence could reactivate a legacy journal.
export function isMissingMasterJournalHandle(error) {
  return error instanceof DOMException && error.name === "NotFoundError" &&
    error.code === DOMException.NOT_FOUND_ERR;
}
