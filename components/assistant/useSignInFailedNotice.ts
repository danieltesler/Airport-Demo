"use client";

import { useEffect, useState } from "react";

const SIGN_IN_FAILED_PARAM = "signin";
const SIGN_IN_FAILED_VALUE = "failed";

/**
 * The login callback sends the user back to "/?signin=failed" when Google or one of our checks said no.
 * Reports whether to show the "didn't complete" notice, and removes the query parameter from the address
 * so a reload (or a copied link) does not show it again. Only used by client-only components, which are
 * never rendered on the server, so reading window in the state initialiser cannot mismatch.
 */
export function useSignInFailedNotice() {
  const [visible, setVisible] = useState(
    () => new URLSearchParams(window.location.search).get(SIGN_IN_FAILED_PARAM) === SIGN_IN_FAILED_VALUE
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(SIGN_IN_FAILED_PARAM)) return;
    url.searchParams.delete(SIGN_IN_FAILED_PARAM);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);

  return { visible, dismiss: () => setVisible(false) };
}
