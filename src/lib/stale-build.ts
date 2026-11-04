/**
 * A FILE FROM THE BUILD BEFORE — THE ERROR A DEPLOY LEAVES IN EVERY OPEN TAB.
 *
 * A tab opened before a deploy still runs the old build's code. The first
 * press that needs a piece it has not loaded yet asks the server for a file
 * the new build no longer has, and the import fails. That is not the
 * screen's fault and «أعد المحاولة» cannot fix it: retrying asks for the
 * same missing file. A full reload fetches the new build, and that does.
 *
 * Matched by the ways the browsers and the bundlers spell it.
 */
export function isStaleBuildError(error: { name?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.name === 'ChunkLoadError') return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return (
    /Loading (?:CSS )?chunk \S+ failed/i.test(message) ||
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('ChunkLoadError')
  );
}

/**
 * ONE RELOAD, AND THE GUARD IS WHAT MAKES IT ONE.
 *
 * If the reload does not cure it — the server really is missing the file,
 * or something keeps serving the old page — an unguarded reload would
 * reload forever and the person could never reach the error screen. The
 * mark in `sessionStorage` says «already tried» for this tab; a second
 * stale-file error inside the window is drawn as any other error, with its
 * buttons.
 *
 * The window, rather than «never again in this tab», because a tab is left
 * open all shift and there may be two deploys in a shift: the second
 * deploy's error, an hour later, deserves its one reload too. Ten minutes is
 * far longer than a reload loop takes to come round, and far shorter than
 * the gap between two deploys.
 *
 * A storage that refuses (a private window, a blocked site) means no
 * automatic reload at all: drawing the screen is the safe direction to fail.
 */
export const STALE_RELOAD_KEY = 'zaki:stale-build-reloaded-at';
export const STALE_RELOAD_WINDOW_MS = 10 * 60_000;

export function reloadOnceForStaleBuild(
  error: { name?: string; message?: string } | null | undefined,
  win: Pick<Window, 'sessionStorage' | 'location'>,
  now: number = Date.now(),
): boolean {
  if (!isStaleBuildError(error)) return false;
  try {
    const last = Number(win.sessionStorage.getItem(STALE_RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < STALE_RELOAD_WINDOW_MS) return false;
    win.sessionStorage.setItem(STALE_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  win.location.reload();
  return true;
}
