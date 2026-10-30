// SmartThings device shape for a price area: discovery fields and state arrays.

import { priceCents } from '../prices/vat.js'
import { deviceIdFor } from '../prices/regions.js'

export const CAPABILITY = 'beachprepare14195.spotPrice'
export const PROFILE_ID = '9df37123-e82b-4ce6-a195-83f2163a4341'
export const MANUFACTURER = 'spot-hinta.fi'
export const PRICE_UNIT = 'c/kWh'

export function discoveryFields(code) {
    return {
        externalDeviceId: deviceIdFor(code),
        friendlyName: `Spot Price ${code}`,
        deviceHandlerType: PROFILE_ID,
        manufacturerName: MANUFACTURER,
        modelName: `Spot price ${code}`,
    }
}

const health = value => ({ component: 'main', capability: 'st.healthCheck', attribute: 'healthStatus', value })

// current: { priceNoTax, rank, start, end } | null (no price covers now)
export function statesFor(region, vatPercent, current) {
    if (!current) return [health('offline')]
    return [
        { component: 'main', capability: CAPABILITY, attribute: 'price', value: priceCents(current.priceNoTax, vatPercent), unit: PRICE_UNIT },
        { component: 'main', capability: CAPABILITY, attribute: 'rank', value: current.rank },
        health('online'),
    ]
}

// { region, vatPercent } → one deviceState entry for a state response or callback
export function deviceStateFor({ region, vatPercent }, prices) {
    return { externalDeviceId: deviceIdFor(region), states: statesFor(region, vatPercent, prices.current(region)) }
}
