const { withCircuitBreaker, getStatus } = require("../services/circuitBreaker");

// Reset circuit state between tests
beforeEach(() => {
  // Access internal circuits map via getStatus to verify clean state
  // The module caches state, so we use unique circuit names per test
});

describe("circuitBreaker", () => {
  test("passes through successful calls (CLOSED state)", async () => {
    const result = await withCircuitBreaker("test-success", () => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(getStatus("test-success").state).toBe("CLOSED");
    expect(getStatus("test-success").failures).toBe(0);
  });

  test("propagates errors and increments failure count", async () => {
    await expect(
      withCircuitBreaker("test-fail", () => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");

    const status = getStatus("test-fail");
    expect(status.state).toBe("CLOSED");
    expect(status.failures).toBe(1);
  });

  test("opens circuit after threshold consecutive failures", async () => {
    const name = "test-open-" + Date.now();

    // Default threshold is 5
    for (let i = 0; i < 5; i++) {
      await expect(
        withCircuitBreaker(name, () => Promise.reject(new Error("fail")))
      ).rejects.toThrow("fail");
    }

    const status = getStatus(name);
    expect(status.state).toBe("OPEN");
    expect(status.failures).toBe(5);
  });

  test("rejects immediately when circuit is OPEN", async () => {
    const name = "test-reject-" + Date.now();

    // Force open
    for (let i = 0; i < 5; i++) {
      await withCircuitBreaker(name, () => Promise.reject(new Error("fail"))).catch(() => {});
    }

    // Next call should be rejected without calling fn
    let fnCalled = false;
    await expect(
      withCircuitBreaker(name, () => {
        fnCalled = true;
        return Promise.resolve("should not run");
      })
    ).rejects.toThrow(/circuit open/i);
    expect(fnCalled).toBe(false);
  });

  test("resets to CLOSED after a successful call", async () => {
    const name = "test-reset-" + Date.now();

    // Cause some failures (below threshold)
    for (let i = 0; i < 3; i++) {
      await withCircuitBreaker(name, () => Promise.reject(new Error("fail"))).catch(() => {});
    }
    expect(getStatus(name).failures).toBe(3);

    // Successful call resets
    await withCircuitBreaker(name, () => Promise.resolve("ok"));
    expect(getStatus(name).failures).toBe(0);
    expect(getStatus(name).state).toBe("CLOSED");
  });

  test("getStatus returns correct shape", () => {
    const status = getStatus("nonexistent");
    expect(status).toEqual({
      name: "nonexistent",
      state: "CLOSED",
      failures: 0,
      lastFailureTime: 0,
    });
  });
});
