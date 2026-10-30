// Always computed from PriceNoTax: spot-hinta's PriceWithTax uses Finnish VAT for FI and
// none for other regions, and users set their own VAT per region anyway.

// EUR/kWh without VAT → c/kWh with VAT, 2 decimals
export function priceCents(priceNoTax, vatPercent) {
    return Math.round(priceNoTax * (100 + vatPercent) * 100) / 100
}
