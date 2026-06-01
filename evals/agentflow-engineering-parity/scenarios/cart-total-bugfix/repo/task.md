# Cart Total Bugfix

`npm test` currently fails because `calculateCartTotal` ignores item quantity, discount, and tax options.

Fix the implementation in `src/cart.js` so:

- each line item contributes `price * quantity`;
- missing quantity defaults to `1`;
- `discountPercent` is applied to the subtotal before tax;
- `taxRate` is applied after discount;
- the final total is rounded to cents.

Run `npm test` and include the command result in your handoff.
