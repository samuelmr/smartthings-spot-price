// SmartThings device shape for a price area: discovery fields and state arrays.

import { priceCents } from '../prices/vat.js'
import { deviceIdFor } from '../prices/regions.js'

export const MANUFACTURER = 'spot-hinta.fi'
export const PRICE_UNIT = 'c/kWh'

// profileId: the device profile, sent as deviceHandlerType
export function discoveryFields(code, profileId) {
    return {
        externalDeviceId: deviceIdFor(code),
        friendlyName: `Spot Price ${code}`,
        deviceHandlerType: profileId,
        manufacturerName: MANUFACTURER,
        modelName: `Spot price ${code}`,
    }
}

const health = value => ({ component: 'main', capability: 'st.healthCheck', attribute: 'healthStatus', value })

// current: { priceNoTax, rank, start, end } | null (no price covers now)
export function statesFor(region, vatPercent, current, capability) {
    if (!current) return [health('offline')]
    return [
        { component: 'main', capability, attribute: 'price', value: priceCents(current.priceNoTax, vatPercent), unit: PRICE_UNIT },
        { component: 'main', capability, attribute: 'rank', value: current.rank },
        health('online'),
    ]
}

// { region, vatPercent } → one deviceState entry for a state response or callback
export function deviceStateFor({ region, vatPercent }, prices, capability) {
    return { externalDeviceId: deviceIdFor(region), states: statesFor(region, vatPercent, prices.current(region), capability) }
}
