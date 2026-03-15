/**
 * Simple circuit breaker for external API calls (e.g. Gemini).
 *
 * States:
 *   CLOSED   — normal operation, requests flow through
 *   OPEN     — too many recent failures, requests are rejected immediately
 *   HALF_OPEN — after cooldown, one probe request is allowed through
 *
 * Configuration via environment variables:
 *   CIRCUIT_BREAKER_THRESHOLD  — consecutive failures before opening (default 5)
 *   CIRCUIT_BREAKER_COOLDOWN   — ms before trying again after opening (default 30000)
 */

const THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || "5", 10);
const COOLDOWN_MS = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN || "30000", 10);

const STATE = { CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" };

// Per-service circuit state
const circuits = {};

function getCircuit(name) {
  if (!circuits[name]) {
    circuits[name] = {
      state: STATE.CLOSED,
      failures: 0,
      lastFailureTime: 0,
    };
  }
  return circuits[name];
}

/**
 * Wrap an async function with circuit breaker protection.
 *
 * @param {string} name  — circuit name (e.g. "gemini", "imageProcessor")
 * @param {Function} fn  — async function to execute
 * @returns {Promise<*>} — result of fn()
 * @throws {Error} — if circuit is open, throws "Service unavailable" instead of calling fn
 */
async function withCircuitBreaker(name, fn) {
  const circuit = getCircuit(name);

  // OPEN: reject immediately unless cooldown has elapsed
  if (circuit.state === STATE.OPEN) {
    const elapsed = Date.now() - circuit.lastFailureTime;
    if (elapsed < COOLDOWN_MS) {
      const waitSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      throw new Error(
        `Service temporarily unavailable (circuit open for "${name}"). Retry in ~${waitSec}s.`
      );
    }
    // Cooldown elapsed → transition to HALF_OPEN (allow one probe)
    circuit.state = STATE.HALF_OPEN;
    console.log(`[circuitBreaker] ${name}: OPEN → HALF_OPEN (probe request allowed)`);
  }

  try {
    const result = await fn();

    // Success → reset circuit
    if (circuit.state !== STATE.CLOSED) {
      console.log(`[circuitBreaker] ${name}: ${circuit.state} → CLOSED (success)`);
    }
    circuit.state = STATE.CLOSED;
    circuit.failures = 0;
    return result;
  } catch (err) {
    circuit.failures++;
    circuit.lastFailureTime = Date.now();

    // If we were probing (HALF_OPEN) and it failed → back to OPEN
    if (circuit.state === STATE.HALF_OPEN) {
      circuit.state = STATE.OPEN;
      console.warn(`[circuitBreaker] ${name}: HALF_OPEN → OPEN (probe failed: ${err.message})`);
    } else if (circuit.failures >= THRESHOLD) {
      circuit.state = STATE.OPEN;
      console.warn(
        `[circuitBreaker] ${name}: CLOSED → OPEN (${circuit.failures} consecutive failures)`
      );
    }

    throw err; // Re-throw so caller still sees the original error
  }
}

/**
 * Get current circuit status (useful for health checks).
 */
function getStatus(name) {
  const circuit = getCircuit(name);
  return {
    name,
    state: circuit.state,
    failures: circuit.failures,
    lastFailureTime: circuit.lastFailureTime,
  };
}

module.exports = { withCircuitBreaker, getStatus };
