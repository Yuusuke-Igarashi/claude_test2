# Disaster Compass Central Asia (mock)

An English-language disaster-preparedness mock app for risk managers of companies and local governments, and their staff, with bases in Kazakhstan, Kyrgyzstan, Tajikistan, Turkmenistan and Uzbekistan. It is the Central Asia edition of the Southeast Asia prototype in `../bousai/` (same code base, English UI, new data). It runs as a single self-contained file (`bousai-ca/index.html`) and makes no network calls except loading Google Fonts (optional; the page renders with system fonts offline).

## Four screens

| # | Screen | Audience | What it shows |
|---|--------|----------|---------------|
| 1 | Risk by region & site | managers and staff | Country/city → site → group tree. City: ThinkHazard hazard levels, return-period loss estimates (GEM / Aqueduct anchored, labelled assumptions), disaster history, seasonality. Site: evacuation plan, shelters, alert channels, preparedness score. Group: local staff & families / supply chain (company) or residents / responders & NGOs (government). |
| 2 | Live reporting | managers and staff | Event cards (Almaty M7.3 earthquake, West Kazakhstan 2024-type spring flood, Tashkent extreme-heat watch) → scenario clock, time slider, auto-play, feed status → Overview / Hazard drivers / Incident log / Sites & supply chain. |
| 3 | Recovery monitoring | managers and staff | After the live phase: one scenario, three recovery timelines over days, weeks and months. Region (local government): shelters, public services by district, damage assessment, housing, schools, businesses. Company: site capacity, staff at work, supply-chain node reopening, cumulative loss, BCP milestones. Personal: public services in your district, compensation, daily-life index. Milestones cite analog events; curves are labelled model assumptions. A what-if simulator (checkboxes and numbers: severity, retrofit, backup power, safety stock, second sourcing, insurance, remote work, temporary housing, compensation speed, household stock, etc.) recomputes recovery speed and cost against the baseline and ranks the gaps as a preparation list with timing. |
| 4 | My dashboard | staff and families | Address (matched to preset residential areas), family and housing inputs → evacuation routes, stock quantities, checklist, family card, and live information for the home district. |

The flow is: know the risk before (1) → follow the event live (2) → track recovery after (3) → personal view (4). Switches at the top right change Company/Government (which groups are shown) and Manager/Staff (crisis-team panels hidden for staff).

## Data and provenance

Every value in `data/*.json` carries a source (`src`/`source_url`) and a `confirmed_by` label: `page_read` (fetched and read in the build session), `derived` (computed from fetched data), `third_party` (secondary source such as Wikipedia), `search_snippet` (web-search summary only; verify before relying on it), `unverified` (could not be verified). Model parameters (return-period multipliers, regional shares, scenario exposure, company sites, supply chains, residence clusters) are assumptions and are labelled as such.

Main sources: ThinkHazard! (GFDRR/World Bank) hazard levels by administrative division; GEM Foundation Country Seismic Risk Profiles v2026.0.0 (CC BY-NC-SA 4.0, non-commercial); USGS ComCat earthquake catalog; WRI Aqueduct Floods (riverine flood urban damage by return period, 2010 baseline); EM-DAT via Our World in Data; ReliefWeb, GDACS, IFRC and ACAPS reports for the 2024 Kazakhstan floods; Natural Earth (public domain) for maps; OpenStreetMap/Nominatim and Wikipedia for coordinates.

Field names keep the `_ja` suffix of the original app (e.g., `name_ja`); all values are English.

## Build

```bash
node bousai-ca/scripts/build.mjs
```

The script inlines `src/` (template, CSS, JS in a fixed order), `geo/` (Natural Earth clipped to Central Asia) and `data/` into `index.html`.

## Limits

- The company, its sites, headcounts, supply chain and residence clusters are fictional; the buildings, districts, hospitals, parks and roads are real places with public coordinates.
- Hazard zones on the site sketch maps approximate published maps and terrain logic; they are not official hazard maps.
- Several national sources (government portals, hydromet archives, embassy pages) were not reachable from the build environment; values taken from search summaries are labelled `search_snippet`.
