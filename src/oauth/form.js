// Server-rendered account-linking page: pick price areas and a VAT % for each. No JS.

import { REGIONS } from '../prices/regions.js'

export const MAX_VAT_PERCENT = 50

const escapeHtml = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const STYLE = `
    body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 32rem; padding: 1rem; line-height: 1.4; }
    h1 { font-size: 1.4rem; }
    table { border-collapse: collapse; width: 100%; }
    td { padding: .35rem .25rem; border-bottom: 1px solid #ddd; }
    td.vat { white-space: nowrap; text-align: right; }
    input[type=text] { width: 4.5rem; font-size: 1rem; text-align: right; }
    input[type=checkbox] { width: 1.2rem; height: 1.2rem; }
    .errors { color: #b00020; border: 1px solid #b00020; padding: .5rem 1rem; border-radius: .25rem; }
    .error { color: #b00020; }
    button { margin-top: 1rem; font-size: 1.1rem; padding: .6rem 1.4rem; }
    p.note { color: #555; font-size: .9rem; }
`

// params: { client_id, redirect_uri, state } passed through as hidden fields
// values: { regions: Set<code>, vat: { [code]: string } } to re-fill after a validation error
// errors: { form?: string, [code]?: string }
export function renderAuthorizePage({ params, values = null, errors = {} }) {
    const hidden = ['client_id', 'redirect_uri', 'state', 'response_type']
        .filter(name => params[name])
        .map(name => `<input type="hidden" name="${name}" value="${escapeHtml(params[name])}">`)
        .join('\n')

    const rows = REGIONS.map(region => {
        const checked = values ? values.regions.has(region.code) : false
        const vat = values?.vat[region.code] ?? String(region.defaultVatPercent)
        const error = errors[region.code]
        return `<tr>
    <td><label><input type="checkbox" name="region" value="${region.code}"${checked ? ' checked' : ''}>
        ${region.code} &ndash; ${escapeHtml(region.name)}</label>${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}</td>
    <td class="vat"><label>VAT <input type="text" inputmode="decimal" name="vat_${region.code}" value="${escapeHtml(vat)}" aria-label="VAT % for ${region.code}"> %</label></td>
</tr>`
    }).join('\n')

    const errorList = Object.values(errors)
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spot Price – choose price areas</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Spot Price</h1>
<p>Choose the electricity price areas to add to SmartThings. Each area becomes a device
showing the current 15-minute spot price (c/kWh) and its rank within the day.</p>
${errorList.length > 0 ? `<div class="errors">${errorList.map(e => `<p>${escapeHtml(e)}</p>`).join('')}</div>` : ''}
<form method="post" action="authorize">
${hidden}
<table>
${rows}
</table>
<p class="note">VAT is added to the price without tax (0&ndash;${MAX_VAT_PERCENT} %).
To change areas or VAT later, remove the integration and add it again.
Prices from spot-hinta.fi.</p>
<button type="submit">Continue</button>
</form>
</body>
</html>
`
}

export function renderErrorPage(message) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spot Price – error</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Spot Price</h1>
<p class="errors">${escapeHtml(message)}</p>
</body>
</html>
`
}
