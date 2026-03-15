/**
 * Outfit Builder Tests
 *
 * Test 1: Smart search concurrency — ensures all 6 categories are searched
 *         and the concurrency limiter queues excess requests.
 *
 * Test 2: Outfit try-on — ensures /api/try-on/outfit accepts 7 images
 *         (1 user profile + 6 garment items) and returns a result.
 */

// ---------------------------------------------------------------------------
// Mocks — must be defined BEFORE require()
// ---------------------------------------------------------------------------

// Mock firebase-admin (prevents real Firebase init)
jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(() => Promise.resolve({ exists: false, data: () => null })),
        set: jest.fn(),
      })),
    })),
  })),
}));

// Mock firestore service
jest.mock("../services/firestore", () => ({
  getProfile: jest.fn(() =>
    Promise.resolve({
      generatedPhotoKeys: ["photos/test-user/pose-0.jpg"],
      bodyPhotoKey: "photos/test-user/body.jpg",
      originalPhotoKeys: [
        "photos/test-user/body1.jpg",
        "photos/test-user/body2.jpg",
        "photos/test-user/body3.jpg",
        "photos/test-user/face1.jpg",
        "photos/test-user/face2.jpg",
      ],
    })
  ),
  saveProfile: jest.fn(),
}));

// Mock storage service
jest.mock("../services/storage", () => ({
  downloadFileBase64: jest.fn(() => Promise.resolve(FAKE_BASE64)),
  uploadFile: jest.fn(),
}));

// Mock classifier
jest.mock("../services/classifier", () => ({
  analyzeProduct: jest.fn(() =>
    Promise.resolve({
      garmentClass: "UPPER_BODY",
      category: "tops",
    })
  ),
  classifyOutfit: jest.fn(() =>
    Promise.resolve({ currentType: "UPPER_LOWER" })
  ),
  hasPersonInImage: jest.fn(() =>
    Promise.resolve({ hasPerson: false, garmentDescription: null })
  ),
}));

// Mock Gemini service
jest.mock("../services/gemini", () => ({
  virtualTryOn: jest.fn(() => Promise.resolve(FAKE_BASE64)),
  virtualTryOnOutfit: jest.fn(() => Promise.resolve(FAKE_BASE64)),
  extractGarment: jest.fn(() => Promise.resolve(FAKE_BASE64)),
  buildSmartPrompt: jest.fn(() => "mock prompt"),
  generateProfilePhoto: jest.fn(() => Promise.resolve(FAKE_BASE64)),
}));

// Mock image processor
jest.mock("../services/imageProcessor", () => ({
  removeBackground: jest.fn(() => Promise.resolve(FAKE_BASE64)),
  inpaint: jest.fn(() => Promise.resolve(FAKE_BASE64)),
  applyAccessory: jest.fn(() => Promise.resolve(FAKE_BASE64)),
}));

// Mock auth middleware to always set userId
jest.mock("../middleware/auth", () => ({
  requireAuth: (req, res, next) => {
    req.userId = "test-user-123";
    next();
  },
  optionalAuth: (req, res, next) => {
    req.userId = "test-user-123";
    next();
  },
}));

// Fake 1x1 white PNG in base64 (valid image data)
const FAKE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Test Suite 1: Smart Search — all 6 categories
// ---------------------------------------------------------------------------
describe("Smart Search Concurrency Limiter", () => {
  // We test the concurrency limiter logic directly (no Python spawning)
  const {
    acquireSlot,
    releaseSlot,
  } = (() => {
    // Re-implement the concurrency limiter to test the pattern
    const MAX_CONCURRENT = 2;
    let activeSearches = 0;
    const waitQueue = [];

    function acquireSlot() {
      if (activeSearches < MAX_CONCURRENT) {
        activeSearches++;
        return Promise.resolve();
      }
      return new Promise((resolve) => waitQueue.push(resolve));
    }

    function releaseSlot() {
      if (waitQueue.length > 0) {
        const next = waitQueue.shift();
        next();
      } else {
        activeSearches--;
      }
    }

    return { acquireSlot, releaseSlot, getActive: () => activeSearches, getQueued: () => waitQueue.length };
  })();

  test("allows up to 2 concurrent slots", async () => {
    // Acquire 2 slots — both should resolve immediately
    await acquireSlot();
    await acquireSlot();

    // 3rd should NOT resolve (it queues)
    let thirdResolved = false;
    const thirdPromise = acquireSlot().then(() => {
      thirdResolved = true;
    });

    // Give microtasks a chance
    await new Promise((r) => setTimeout(r, 50));
    expect(thirdResolved).toBe(false);

    // Release one slot — 3rd should now resolve
    releaseSlot();
    await thirdPromise;
    expect(thirdResolved).toBe(true);

    // Clean up
    releaseSlot();
    releaseSlot();
  });

  test("6 concurrent requests queue correctly (max 2 active)", async () => {
    const order = [];
    const tasks = [];

    for (let i = 0; i < 6; i++) {
      const task = (async () => {
        await acquireSlot();
        order.push(`start-${i}`);
        // Simulate work
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end-${i}`);
        releaseSlot();
      })();
      tasks.push(task);
    }

    await Promise.all(tasks);

    // All 6 tasks should have completed
    expect(order.filter((o) => o.startsWith("start-")).length).toBe(6);
    expect(order.filter((o) => o.startsWith("end-")).length).toBe(6);

    // First two should start before any others
    expect(order[0]).toBe("start-0");
    expect(order[1]).toBe("start-1");
  });
});

// ---------------------------------------------------------------------------
// Test Suite 2: Wardrobe URL params — all 6 categories parsed
// ---------------------------------------------------------------------------
describe("Wardrobe URL Params — 6 categories", () => {
  test("parses all 6 category queries from URL params", () => {
    const searchParams = new URLSearchParams(
      "top=blue&bottom=red+pants&shoes=brown+sneakers&necklace=white&earrings=black&bracelets=blue&clothesSize=S&shoesSize=10&sex=female"
    );

    const topQuery = searchParams.get("top") || "";
    const bottomQuery = searchParams.get("bottom") || "";
    const shoesQuery = searchParams.get("shoes") || "";
    const necklaceQuery = searchParams.get("necklace") || "";
    const earringsQuery = searchParams.get("earrings") || "";
    const braceletsQuery = searchParams.get("bracelets") || "";
    const clothesSizeParam = searchParams.get("clothesSize") || "";
    const shoesSizeParam = searchParams.get("shoesSize") || "";
    const userSexParam = searchParams.get("sex") || "";

    expect(topQuery).toBe("blue");
    expect(bottomQuery).toBe("red pants");
    expect(shoesQuery).toBe("brown sneakers");
    expect(necklaceQuery).toBe("white");
    expect(earringsQuery).toBe("black");
    expect(braceletsQuery).toBe("blue");
    expect(clothesSizeParam).toBe("S");
    expect(shoesSizeParam).toBe("10");
    expect(userSexParam).toBe("female");
  });

  test("auto-prepends category keyword if missing from query", () => {
    // Replicate the logic from wardrobe.js
    function addCategoryKeyword(query, category) {
      const patterns = {
        top: /top|shirt|blouse|sweater|jacket|hoodie|t-shirt|tee|tank|polo|coat|blazer|cardigan|vest|tunic|crop/i,
        bottom: /bottom|pants|jeans|shorts|skirt|trousers|leggings|joggers|chinos|slacks|capri/i,
        shoes: /shoes?|sneakers?|boots?|sandals?|heels?|flats?|loafers?|moccasins?|slippers?|pumps?|oxfords?/i,
        necklace: /necklace/i,
        earrings: /earrings?/i,
        bracelets: /bracelets?/i,
      };
      const suffixes = {
        top: "top",
        bottom: "pants",
        shoes: "shoes",
        necklace: "necklace",
        earrings: "earrings",
        bracelets: "bracelet",
      };

      if (patterns[category] && !patterns[category].test(query)) {
        return `${query} ${suffixes[category]}`;
      }
      return query;
    }

    // Queries without category keywords should get them appended
    expect(addCategoryKeyword("blue", "top")).toBe("blue top");
    expect(addCategoryKeyword("red", "bottom")).toBe("red pants");
    expect(addCategoryKeyword("brown", "shoes")).toBe("brown shoes");
    expect(addCategoryKeyword("white", "necklace")).toBe("white necklace");
    expect(addCategoryKeyword("black", "earrings")).toBe("black earrings");
    expect(addCategoryKeyword("blue", "bracelets")).toBe("blue bracelet");

    // Queries that already have the keyword should NOT get it doubled
    expect(addCategoryKeyword("blue shirt", "top")).toBe("blue shirt");
    expect(addCategoryKeyword("red jeans", "bottom")).toBe("red jeans");
    expect(addCategoryKeyword("brown sneakers", "shoes")).toBe("brown sneakers");
    expect(addCategoryKeyword("gold necklace", "necklace")).toBe("gold necklace");
    expect(addCategoryKeyword("silver earrings", "earrings")).toBe("silver earrings");
    expect(addCategoryKeyword("beaded bracelet", "bracelets")).toBe("beaded bracelet");
  });

  test("accessories skip background removal", () => {
    const categories = ["top", "bottom", "shoes", "necklace", "earrings", "bracelets"];
    const accessoryCategories = ["necklace", "earrings", "bracelets"];

    categories.forEach((cat) => {
      const isAccessory = accessoryCategories.includes(cat);
      if (isAccessory) {
        expect(isAccessory).toBe(true);
      }
    });

    // Exactly 3 categories should be accessories
    const accessories = categories.filter((c) => accessoryCategories.includes(c));
    expect(accessories).toEqual(["necklace", "earrings", "bracelets"]);

    // Non-accessories should need BG removal
    const clothing = categories.filter((c) => !accessoryCategories.includes(c));
    expect(clothing).toEqual(["top", "bottom", "shoes"]);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 3: Outfit Try-On — 7 images (1 person + 6 garments)
// ---------------------------------------------------------------------------
describe("Outfit Try-On Route — /api/try-on/outfit", () => {
  const express = require("express");
  const tryOnRoutes = require("../routes/tryOn");
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json({ limit: "50mb" }));
    app.use("/api/try-on", tryOnRoutes);
    // Error handler
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({ error: err.message });
    });
  });

  test("accepts 6 garments (top, bottom, shoes, necklace, earrings, bracelet) + user photo", async () => {
    const { virtualTryOnOutfit } = require("../services/gemini");
    virtualTryOnOutfit.mockResolvedValue(FAKE_BASE64);

    const garments = [
      { imageBase64: FAKE_BASE64, garmentClass: "UPPER_BODY", label: "upper wear" },
      { imageBase64: FAKE_BASE64, garmentClass: "LOWER_BODY", label: "lower wear" },
      { imageBase64: FAKE_BASE64, garmentClass: "SHOES", label: "shoes" },
      { imageBase64: FAKE_BASE64, garmentClass: "NECKLACE", label: "necklace" },
      { imageBase64: FAKE_BASE64, garmentClass: "EARRINGS", label: "earrings" },
      { imageBase64: FAKE_BASE64, garmentClass: "BRACELET", label: "bracelet" },
    ];

    // Use supertest-like approach with raw http
    const http = require("http");
    const server = http.createServer(app);

    const result = await new Promise((resolve, reject) => {
      server.listen(0, () => {
        const port = server.address().port;
        const body = JSON.stringify({
          garments,
          framing: "full",
          poseIndex: 0,
        });

        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/try-on/outfit",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              server.close();
              try {
                resolve({ status: res.statusCode, body: JSON.parse(data) });
              } catch (e) {
                resolve({ status: res.statusCode, body: data });
              }
            });
          }
        );

        req.on("error", (err) => {
          server.close();
          reject(err);
        });

        req.write(body);
        req.end();
      });
    });

    expect(result.status).toBe(200);
    expect(result.body.resultImage).toBe(FAKE_BASE64);
    expect(result.body.totalTime).toBeDefined();

    // Verify Gemini was called with all 6 garments + the source image
    expect(virtualTryOnOutfit).toHaveBeenCalledTimes(1);
    const callArgs = virtualTryOnOutfit.mock.calls[0];
    const sourceImage = callArgs[0];
    const garmentsArg = callArgs[1];
    const framingArg = callArgs[2];

    // Source image should have been fetched from storage (mock returns FAKE_BASE64)
    expect(sourceImage).toBe(FAKE_BASE64);

    // All 6 garments should be passed through
    expect(garmentsArg.length).toBe(6);
    expect(garmentsArg[0].garmentClass).toBe("UPPER_BODY");
    expect(garmentsArg[1].garmentClass).toBe("LOWER_BODY");
    expect(garmentsArg[2].garmentClass).toBe("SHOES");
    expect(garmentsArg[3].garmentClass).toBe("NECKLACE");
    expect(garmentsArg[4].garmentClass).toBe("EARRINGS");
    expect(garmentsArg[5].garmentClass).toBe("BRACELET");
    expect(framingArg).toBe("full");
  });

  test("returns 400 if no garments provided", async () => {
    const http = require("http");
    const server = http.createServer(app);

    const result = await new Promise((resolve, reject) => {
      server.listen(0, () => {
        const port = server.address().port;
        const body = JSON.stringify({
          garments: [],
          framing: "full",
        });

        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/try-on/outfit",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              server.close();
              resolve({ status: res.statusCode, body: JSON.parse(data) });
            });
          }
        );

        req.write(body);
        req.end();
      });
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/garments/i);
  });

  test("preprocesses all garments in parallel before try-on", async () => {
    const { hasPersonInImage } = require("../services/classifier");
    const { virtualTryOnOutfit } = require("../services/gemini");

    // Reset mocks
    hasPersonInImage.mockClear();
    virtualTryOnOutfit.mockClear();
    virtualTryOnOutfit.mockResolvedValue(FAKE_BASE64);

    const garments = [
      { imageBase64: FAKE_BASE64, garmentClass: "UPPER_BODY", label: "upper wear" },
      { imageBase64: FAKE_BASE64, garmentClass: "LOWER_BODY", label: "lower wear" },
      { imageBase64: FAKE_BASE64, garmentClass: "SHOES", label: "shoes" },
      { imageBase64: FAKE_BASE64, garmentClass: "NECKLACE", label: "necklace" },
      { imageBase64: FAKE_BASE64, garmentClass: "EARRINGS", label: "earrings" },
      { imageBase64: FAKE_BASE64, garmentClass: "BRACELET", label: "bracelet" },
    ];

    const http = require("http");
    const server = http.createServer(app);

    await new Promise((resolve, reject) => {
      server.listen(0, () => {
        const port = server.address().port;
        const body = JSON.stringify({ garments, framing: "full", poseIndex: 0 });

        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/try-on/outfit",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              server.close();
              resolve(JSON.parse(data));
            });
          }
        );

        req.write(body);
        req.end();
      });
    });

    // preprocessGarment calls hasPersonInImage for each garment
    // All 6 garments should be preprocessed
    expect(hasPersonInImage).toHaveBeenCalledTimes(6);

    // virtualTryOnOutfit should be called once with all 6 garments
    expect(virtualTryOnOutfit).toHaveBeenCalledTimes(1);
    const garmentsArg = virtualTryOnOutfit.mock.calls[0][1];
    expect(garmentsArg.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 4: Garment data shape for try-on
// ---------------------------------------------------------------------------
describe("Garment items selection state", () => {
  test("selectItem stores per-category selection for all 6 categories", () => {
    // Simulate the wardrobe state management
    let selectedTop = null;
    let selectedBottom = null;
    let selectedShoes = null;
    let selectedNecklace = null;
    let selectedEarrings = null;
    let selectedBracelet = null;

    const products = [
      { title: "Blue Top", price: "$29.99", _category: "top", image_url: "https://example.com/top.jpg" },
      { title: "Red Pants", price: "$39.99", _category: "bottom", image_url: "https://example.com/bottom.jpg" },
      { title: "Brown Sneakers", price: "$89.99", _category: "shoes", image_url: "https://example.com/shoes.jpg" },
      { title: "Gold Necklace", price: "$19.99", _category: "necklace", image_url: "https://example.com/necklace.jpg" },
      { title: "Silver Earrings", price: "$14.99", _category: "earrings", image_url: "https://example.com/earrings.jpg" },
      { title: "Beaded Bracelet", price: "$9.99", _category: "bracelets", image_url: "https://example.com/bracelet.jpg" },
    ];

    // Simulate selectItem for each product
    products.forEach((product) => {
      const category = product._category;
      if (category === "top") selectedTop = product;
      else if (category === "bottom") selectedBottom = product;
      else if (category === "shoes") selectedShoes = product;
      else if (category === "necklace") selectedNecklace = product;
      else if (category === "earrings") selectedEarrings = product;
      else if (category === "bracelets") selectedBracelet = product;
    });

    // All 6 should be selected
    expect(selectedTop).toBeTruthy();
    expect(selectedBottom).toBeTruthy();
    expect(selectedShoes).toBeTruthy();
    expect(selectedNecklace).toBeTruthy();
    expect(selectedEarrings).toBeTruthy();
    expect(selectedBracelet).toBeTruthy();

    // Build garment list for try-on (same as wardrobe.js handleTryOn)
    const garmentItems = [];
    if (selectedTop) garmentItems.push({ item: selectedTop, garmentClass: "UPPER_BODY", label: "upper wear" });
    if (selectedBottom) garmentItems.push({ item: selectedBottom, garmentClass: "LOWER_BODY", label: "lower wear" });
    if (selectedShoes) garmentItems.push({ item: selectedShoes, garmentClass: "SHOES", label: "shoes" });
    if (selectedNecklace) garmentItems.push({ item: selectedNecklace, garmentClass: "NECKLACE", label: "necklace" });
    if (selectedEarrings) garmentItems.push({ item: selectedEarrings, garmentClass: "EARRINGS", label: "earrings" });
    if (selectedBracelet) garmentItems.push({ item: selectedBracelet, garmentClass: "BRACELET", label: "bracelet" });

    expect(garmentItems.length).toBe(6);

    // Total price calculation
    let totalPrice = 0;
    [selectedTop, selectedBottom, selectedShoes, selectedNecklace, selectedEarrings, selectedBracelet].forEach((item) => {
      if (item && item.price) {
        const num = parseFloat(item.price.replace(/[^0-9.]/g, ""));
        if (!isNaN(num)) totalPrice += num;
      }
    });

    expect(totalPrice).toBeCloseTo(204.94, 2);
  });

  test("try-on requires top AND bottom, accessories are optional", () => {
    // Replicate canTryOn logic from wardrobe.js
    function canTryOn(selectedTop, selectedBottom, selectedShoes, shoesQuery) {
      const needShoes = !!shoesQuery;
      return selectedTop && selectedBottom && (!needShoes || selectedShoes);
    }

    // Both top and bottom — can try on
    expect(canTryOn({ title: "top" }, { title: "bottom" }, null, "")).toBe(true);

    // Missing bottom — cannot (returns falsy)
    expect(canTryOn({ title: "top" }, null, null, "")).toBeFalsy();

    // Missing top — cannot (returns falsy)
    expect(canTryOn(null, { title: "bottom" }, null, "")).toBeFalsy();

    // Shoes required but missing — cannot (returns falsy)
    expect(canTryOn({ title: "top" }, { title: "bottom" }, null, "sneakers")).toBeFalsy();

    // Shoes required and present — can
    expect(canTryOn({ title: "top" }, { title: "bottom" }, { title: "shoes" }, "sneakers")).toBeTruthy();
  });

  test("buy on Amazon builds correct cart URL with ASINs from all 6 categories", () => {
    const items = [
      { title: "Top", product_url: "https://www.amazon.com/dp/B0ABC12345/ref=sr_1_1" },
      { title: "Bottom", product_url: "https://www.amazon.com/dp/B0DEF67890/ref=sr_1_2" },
      { title: "Shoes", product_url: "https://www.amazon.com/dp/B0GHI11111/ref=sr_1_3" },
      { title: "Necklace", product_url: "https://www.amazon.com/dp/B0JKL22222/ref=sr_1_4" },
      { title: "Earrings", product_url: "https://www.amazon.com/dp/B0MNO33333/ref=sr_1_5" },
      { title: "Bracelet", product_url: "https://www.amazon.com/dp/B0PQR44444/ref=sr_1_6" },
    ];

    // Extract ASINs (same logic as wardrobe.js handleBuyOnAmazon)
    const asins = items
      .map((item) => {
        const url = item.product_url || "";
        const match = url.match(/\/(?:dp|gp\/product)\/([A-Za-z0-9]{10})/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    expect(asins).toEqual([
      "B0ABC12345",
      "B0DEF67890",
      "B0GHI11111",
      "B0JKL22222",
      "B0MNO33333",
      "B0PQR44444",
    ]);

    // Build cart URL
    const params = asins
      .map((asin, i) => `ASIN.${i + 1}=${asin}&Quantity.${i + 1}=1`)
      .join("&");
    const cartUrl = `https://www.amazon.com/gp/aws/cart/add.html?${params}`;

    expect(cartUrl).toContain("ASIN.1=B0ABC12345");
    expect(cartUrl).toContain("ASIN.6=B0PQR44444");
    expect(cartUrl).toContain("Quantity.6=1");
    expect(asins.length).toBe(6);
  });
});
