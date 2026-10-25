// devicePixelRatio changes: moving the window to a HiDPI screen, or browser zoom. There is no event
// for it, only a resolution media query for the current ratio, which has to be re-armed each time.
// Some browsers (headless ones among them) don't fire it, so renderers also call check() as they draw.

export interface PixelRatioWatch {
  /** Compare with the ratio last seen; calls onChange if it moved. Cheap: one property read. */
  check(): void;
  dispose(): void;
}

/** Call `onChange` whenever window.devicePixelRatio changes. */
export function watchPixelRatio(onChange: (dpr: number) => void): PixelRatioWatch {
  let last = window.devicePixelRatio || 1;
  let mq: MediaQueryList | null = null;
  const arm = () => {
    mq?.removeEventListener('change', check);
    mq = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${last}dppx)`) : null;
    mq?.addEventListener('change', check);
  };
  function check() {
    const now = window.devicePixelRatio || 1;
    if (now === last) return;
    last = now;
    arm();
    onChange(now);
  }
  arm();
  return {
    check,
    dispose() {
      mq?.removeEventListener('change', check);
      mq = null;
    },
  };
}
