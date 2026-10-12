// Reference no-op balance-action plugin (EMPTY implementation).
// The public repo ships this so plugin wiring is exercised end to end
// (the no-op plugin passes the same integration tests) without defining
// any actual behavior.
import type { BalanceActionPlugin } from "./interface.js";

export class NoopBalanceActionPlugin implements BalanceActionPlugin {
  readonly id = "noop-balance-action";

  onBalanceChange(): Promise<void> | void {
    // intentionally does nothing
  }
}
