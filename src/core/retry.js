export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `fn`, tried up to `attempts` times in all, `delayMs` × attempt apart (so
// each wait is longer than the last). A failure past the last attempt is
// thrown; each one before it is reported to `onRetry(error, attempt)`.
export async function retry(fn, { attempts = 3, delayMs = 2000, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      onRetry?.(error, attempt);
      await wait(delayMs * attempt);
    }
  }
}
