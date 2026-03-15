/**
 * Wrap a promise with a timeout.
 * Rejects with a descriptive error if the promise doesn't settle within `ms`.
 *
 * @param {Promise} promise - The promise to race against the timer
 * @param {number} ms - Timeout in milliseconds
 * @param {string} label - Label for the error message
 * @returns {Promise}
 */
function withTimeout(promise, ms, label = "API call") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
