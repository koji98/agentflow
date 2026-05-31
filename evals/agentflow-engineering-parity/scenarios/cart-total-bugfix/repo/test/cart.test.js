import assert from "node:assert/strict";
import { test } from "node:test";

import { calculateCartTotal } from "../src/cart.js";

test("calculates quantities, discount, and tax", () => {
  const total = calculateCartTotal(
    [
      { price: 12.5, quantity: 2 },
      { price: 4, quantity: 3 },
      { price: 10 }
    ],
    { discountPercent: 10, taxRate: 0.0825 }
  );

  assert.equal(total, 45.79);
});

test("defaults missing quantity to one", () => {
  assert.equal(calculateCartTotal([{ price: 9.99 }]), 9.99);
});
