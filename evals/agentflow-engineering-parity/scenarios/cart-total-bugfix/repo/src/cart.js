export function calculateCartTotal(items, options = {}) {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0);

  if (options.discountPercent) {
    return subtotal - options.discountPercent;
  }

  return subtotal;
}
