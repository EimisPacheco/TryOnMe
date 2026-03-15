const { validateBase64Image, validateImagePayload } = require("../middleware/validation");

describe("validateBase64Image", () => {
  // A tiny valid base64-encoded 1x1 white JPEG
  const VALID_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP8B////AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP////wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFBABAAAAAAAAAAAAAAAAAAAACf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKgA/9k=";

  test("accepts valid base64 image data", () => {
    const result = validateBase64Image(VALID_B64);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("accepts valid data URI with prefix", () => {
    const result = validateBase64Image(`data:image/jpeg;base64,${VALID_B64}`);
    expect(result.valid).toBe(true);
  });

  test("rejects empty string", () => {
    const result = validateBase64Image("");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/non-empty/i);
  });

  test("rejects non-string input", () => {
    expect(validateBase64Image(null).valid).toBe(false);
    expect(validateBase64Image(123).valid).toBe(false);
    expect(validateBase64Image(undefined).valid).toBe(false);
  });

  test("rejects malformed data URI (no comma)", () => {
    const result = validateBase64Image("data:image/jpeg;base64");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/malformed/i);
  });

  test("rejects data exceeding max size", () => {
    // 100 bytes max, provide ~200 bytes of base64
    const large = "A".repeat(300);
    const result = validateBase64Image(large, 100);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too large/i);
  });

  test("rejects invalid base64 characters", () => {
    const result = validateBase64Image("not!valid@base64#data");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid base64/i);
  });
});

describe("validateImagePayload", () => {
  test("calls next() for payloads under 50MB", () => {
    const req = { headers: { "content-length": "1000" } };
    const res = {};
    const next = jest.fn();
    validateImagePayload(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test("rejects payloads over 50MB", () => {
    const req = { headers: { "content-length": String(60 * 1024 * 1024) } };
    const jsonFn = jest.fn();
    const res = { status: jest.fn(() => ({ json: jsonFn })) };
    const next = jest.fn();
    validateImagePayload(req, res, next);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(next).not.toHaveBeenCalled();
  });

  test("calls next() when content-length header is missing", () => {
    const req = { headers: {} };
    const res = {};
    const next = jest.fn();
    validateImagePayload(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
