// Let go of the GPU before the browser tears the page down. Closing a tab mid-match with the render
// loop still running and the WebGL context still live is left to the browser, and on a loaded
// machine that teardown has been seen to take seconds (CI: "context would not close").

/**
 * Run `stop` once the page is going away for good: closed, reloaded or navigated off. Not when it is
 * parked in the back-forward cache (persisted), since it may come back to the same screen.
 * `stop` should cancel the render loop and dispose the renderer, which loses the WebGL context.
 * Returns the unsubscribe, for the screen's own teardown.
 */
export function onPageGone(stop: () => void): () => void {
  const h = (e: PageTransitionEvent) => {
    if (!e.persisted) stop();
  };
  addEventListener('pagehide', h);
  return () => removeEventListener('pagehide', h);
}
