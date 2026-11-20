// Repeats `check` until it returns a value. `undefined` means "not yet"; a throw fails at once.
// No time limit: the run's kill timer bounds a stuck wait, and the printed `what` names it.
export default async function waitFor<T>(what: string, check: () => T | undefined): Promise<T> {
  let announced = false;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (!announced) {
      announced = true;
      console.log(`    waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
