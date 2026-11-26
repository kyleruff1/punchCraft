/**
 * A reason storage cannot be used that is worth telling the athlete, in
 * words written for them — "already open in another tab", say.
 *
 * Anything else `prepareStorage()` rejects with is a fault: the screen says
 * only that the database did not load, and the details go to the log.
 */
export class StorageNotice extends Error {
  override readonly name = 'StorageNotice'
}
