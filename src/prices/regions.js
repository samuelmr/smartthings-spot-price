// spot-hinta.fi price areas. defaultVatPercent pre-fills the linking form; the user can
// change it. Rates as of 2026-10; verify before relying on them.

export const REGIONS = [
    { code: 'FI', name: 'Finland', timeZone: 'Europe/Helsinki', defaultVatPercent: 25.5 },
    { code: 'EE', name: 'Estonia', timeZone: 'Europe/Tallinn', defaultVatPercent: 24 },
    { code: 'LV', name: 'Latvia', timeZone: 'Europe/Riga', defaultVatPercent: 21 },
    { code: 'LT', name: 'Lithuania', timeZone: 'Europe/Vilnius', defaultVatPercent: 21 },
    { code: 'SE1', name: 'Sweden, Luleå', timeZone: 'Europe/Stockholm', defaultVatPercent: 25 },
    { code: 'SE2', name: 'Sweden, Sundsvall', timeZone: 'Europe/Stockholm', defaultVatPercent: 25 },
    { code: 'SE3', name: 'Sweden, Stockholm', timeZone: 'Europe/Stockholm', defaultVatPercent: 25 },
    { code: 'SE4', name: 'Sweden, Malmö', timeZone: 'Europe/Stockholm', defaultVatPercent: 25 },
    { code: 'NO1', name: 'Norway, Oslo', timeZone: 'Europe/Oslo', defaultVatPercent: 25 },
    { code: 'NO2', name: 'Norway, Kristiansand', timeZone: 'Europe/Oslo', defaultVatPercent: 25 },
    { code: 'NO3', name: 'Norway, Trondheim', timeZone: 'Europe/Oslo', defaultVatPercent: 25 },
    { code: 'NO4', name: 'Norway, Tromsø', timeZone: 'Europe/Oslo', defaultVatPercent: 0 },
    { code: 'NO5', name: 'Norway, Bergen', timeZone: 'Europe/Oslo', defaultVatPercent: 25 },
    { code: 'DK1', name: 'Denmark, West', timeZone: 'Europe/Copenhagen', defaultVatPercent: 25 },
    { code: 'DK2', name: 'Denmark, East', timeZone: 'Europe/Copenhagen', defaultVatPercent: 25 },
]

const byCode = new Map(REGIONS.map(region => [region.code, region]))

export const getRegion = code => byCode.get(code) ?? null

export const deviceIdFor = code => `spot-price-${code}`
