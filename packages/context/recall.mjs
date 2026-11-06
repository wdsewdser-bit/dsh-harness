/** Read bounded evidence with fresh ACL, expiry and hash checks; 08 §3.3. */
export const recall = (store, ref, range, principal) => {
  try {
    return { status: 'ok', ...store.read(ref, range, principal) };
  } catch (error) {
    if (['denied', 'expired', 'corrupt'].includes(error.code)) {
      return { status: error.code };
    }
    throw error;
  }
};
