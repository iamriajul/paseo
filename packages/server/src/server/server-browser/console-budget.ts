/**
 * How much console a tab reads in a second. With the Runtime domain on, the page's renderer sends
 * Chrome's browser process one event per console call; a page logging in a tight loop outruns
 * what the browser can forward, however fast the client reads, so the browser holds the rest in
 * memory and every other tab on the connection waits behind them. Past the budget
 * the tab turns the Runtime domain off for a while, which stops the events at the page. The budget
 * keeps a page's ordinary bursts (a few hundred lines at start-up); a flood runs at tens of
 * thousands a second.
 */
export const CONSOLE_BUDGET = { messages: 1_000, chars: 1_000_000, windowMs: 1_000 } as const;

export class ConsoleBudget {
  private windowStart = Number.NEGATIVE_INFINITY;
  private messages = 0;
  private chars = 0;

  /** Counts one console message; false once this second's budget is spent. */
  public admit(now: number, length: number): boolean {
    if (now - this.windowStart >= CONSOLE_BUDGET.windowMs) {
      this.windowStart = now;
      this.messages = 0;
      this.chars = 0;
    }
    this.messages += 1;
    this.chars += length;
    return this.messages <= CONSOLE_BUDGET.messages && this.chars <= CONSOLE_BUDGET.chars;
  }

  public reset(): void {
    this.windowStart = Number.NEGATIVE_INFINITY;
  }
}
